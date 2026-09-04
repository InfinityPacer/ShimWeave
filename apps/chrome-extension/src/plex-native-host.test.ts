import {
  PLEX_NATIVE_PROTOCOL,
  type PlexMediaSourceNotice,
  type PlexNativeMessage,
  type PlexRequestStartedNotice,
} from '@shimweave/adapter-plex';
import type { MediaDescriptor, PlaybackPlan } from '@shimweave/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveBrowserPlayback } from './playback-runtime.js';
import {
  BrowserMediaElementError,
  BrowserPlaybackProbeRequiredError,
  BrowserPlaybackUnsupportedError,
} from './playback-runtime.js';
import { PlexNativePlaybackHost } from './plex-native-host.js';

const descriptor: MediaDescriptor = {
  sourceId: 'source-a',
  sizeBytes: 1_000,
  durationSeconds: 120,
  container: 'matroska',
  mimeType: 'video/x-matroska',
  tracks: [{ id: 'video-1', kind: 'video', codec: 'hevc', codecString: 'hvc1.2.4.L153.B0' }],
};
const plan: PlaybackPlan = {
  strategy: 'remux',
  path: 'mse-remux',
  configurationKey: 'configuration-a',
  mediaFingerprint: 'fingerprint-a',
  outputContainer: 'mp4',
  videoTrackId: 'video-1',
};

class TestMediaElement extends EventTarget {
  readonly dataset: DOMStringMap = {} as DOMStringMap;
  currentTime = 12;
  duration = 120;
  paused = false;
  ended = false;
}

describe('PlexNativePlaybackHost', () => {
  it('只有正常 MPD 请求时不创建 Worker、探测或 Range 会话', async () => {
    const createPlaybackRuntime = vi.fn();
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime,
      resolveMediaElement: () => undefined,
      postMessage: vi.fn(),
      readStartSeconds: () => undefined,
    });

    host.acceptRuntimeMessage(started('request-local', 'playback-local', 'source-local'));
    await host.dispose();

    expect(createPlaybackRuntime).not.toHaveBeenCalled();
  });

  it('正常请求和迟到 302 不创建媒体运行时', async () => {
    const createPlaybackRuntime = vi.fn();
    const released: PlexMediaSourceNotice[] = [];
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime,
      resolveMediaElement: () => undefined,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      releaseNotice: (notice) => released.push(notice),
    });

    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(started('request-2', 'playback-2', 'source-2'));
    host.acceptRuntimeMessage(redirect('request-1', 'playback-1', 'source-1'));
    await host.dispose();

    expect(createPlaybackRuntime).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(released).toHaveLength(1);
  });

  it('同一网络请求只能由第一个媒体源认领', async () => {
    const released: PlexMediaSourceNotice[] = [];
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: vi.fn(),
      resolveMediaElement: () => undefined,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      releaseNotice: (notice) => released.push(notice),
      createNoticeId: () => 'notice_id_1234567890',
    });
    const first = redirect('request-1', 'playback-1', 'source-1');
    const duplicate = control('request-1', 'playback-1', 'source-1');

    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(first);
    host.acceptRuntimeMessage(duplicate);

    expect(posted.filter((message) => message.type === 'source-available')).toHaveLength(1);
    expect(released).toEqual([duplicate]);
    await host.dispose();
    expect(released).toEqual([duplicate, first]);
  });

  it('只在 Hook 认领后以同一个 video 启动媒体运行时', async () => {
    const media = new TestMediaElement();
    const stop = vi.fn(async () => undefined);
    const completion = deferred<void>();
    const start = vi.fn(async () => activePlayback(stop, completion.promise));
    const runtimeStop = vi.fn(async () => undefined);
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({ start, stop: runtimeStop }),
      resolveMediaElement: (sessionId) =>
        sessionId === 'native_session_1234567890'
          ? (media as unknown as HTMLMediaElement)
          : undefined,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => 12,
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);

    expect(start).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'source-available',
      requestKey: notice.requestKey,
      sourceKey: notice.sourceKey,
      noticeId: 'notice_id_1234567890',
    });

    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        source: notice.source,
        mediaElement: media,
        startSeconds: 12,
        onDescriptor: expect.any(Function),
      }),
    );
    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: 'native_session_1234567890',
    });

    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-stop',
      sessionId: 'native_session_1234567890',
    });
    await flush();
    expect(runtimeStop).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: 'native_session_1234567890',
    });
    await host.dispose();
  });

  it('受控 Range provider 复用同一个 Host 和播放运行时', async () => {
    const media = new TestMediaElement();
    const start = vi.fn(async () => activePlayback(vi.fn(), new Promise<void>(() => undefined)));
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({ start, stop: vi.fn(async () => undefined) }),
      resolveMediaElement: () => media as unknown as HTMLMediaElement,
      postMessage: vi.fn(),
      readStartSeconds: () => undefined,
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = control('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        source: notice.source,
        mediaElement: media,
        onDescriptor: expect.any(Function),
      }),
    );
    await host.dispose();
  });

  it('缺少精确 video 或播放失败时要求 Hook 恢复 Plex 原链路', async () => {
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => {
        throw new Error('runtime must not be created');
      },
      resolveMediaElement: () => undefined,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: 'native_session_1234567890',
      code: 'media_element_unavailable',
    });
    await host.dispose();
  });

  it('能力规划明确不支持时报告媒体格式错误', async () => {
    const media = new TestMediaElement();
    const posted: PlexNativeMessage[] = [];
    const presented: unknown[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({
        start: async (request) => {
          request.onDescriptor?.({
            ...descriptor,
            tracks: [
              {
                id: 'video-1',
                kind: 'video',
                codec: 'hevc',
                codecString: 'dvh1.05.06',
                hdr: { kind: 'dolby-vision', profile: 5, level: 6 },
              },
              { id: 'audio-1', kind: 'audio', codec: 'eac3', isDefault: true },
            ],
          });
          throw new BrowserPlaybackUnsupportedError('no_supported_playback_path');
        },
        stop: async () => undefined,
      }),
      resolveMediaElement: () => media as unknown as HTMLMediaElement,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      presentFailure: (failure, formats) => presented.push({ failure, formats }),
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: 'native_session_1234567890',
      code: 'media_format_error',
    });
    expect(presented).toEqual([
      {
        failure: {
          code: 'media_format_error',
          message: '当前浏览器不支持此媒体格式。',
        },
        formats: { video: 'Dolby Vision P5 / HEVC', audio: 'EAC3' },
      },
    ]);
    await host.dispose();
  });

  it('一次有界描述后仍缺少执行证据时不会误报媒体格式错误', async () => {
    const media = new TestMediaElement();
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({
        start: async () => {
          throw new BrowserPlaybackProbeRequiredError(['media-facts']);
        },
        stop: async () => undefined,
      }),
      resolveMediaElement: () => media as unknown as HTMLMediaElement,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: 'native_session_1234567890',
      code: 'media_probe_failed',
    });
    await host.dispose();
  });

  it('Hook 拒绝未匹配媒体源时立即释放对应直链状态', async () => {
    const released: PlexMediaSourceNotice[] = [];
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => {
        throw new Error('runtime must not be created');
      },
      resolveMediaElement: () => undefined,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      releaseNotice: (notice) => released.push(notice),
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);

    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'source-rejected',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
    });

    expect(released).toEqual([notice]);
    await host.dispose();
    expect(released).toEqual([notice]);
  });

  it('快速切集会停止旧运行时并丢弃迟到的旧播放结果', async () => {
    const media = new TestMediaElement();
    const firstStop = vi.fn(async () => undefined);
    const secondStop = vi.fn(async () => undefined);
    const firstStart = deferred<ActiveBrowserPlayback>();
    const runtimeStop = vi.fn(async () => undefined);
    const completion = deferred<void>();
    let calls = 0;
    const start = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? firstStart.promise
        : Promise.resolve(activePlayback(secondStop, completion.promise));
    });
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({ start, stop: runtimeStop }),
      resolveMediaElement: () => media as unknown as HTMLMediaElement,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      createNoticeId: () => `notice_id_${posted.length.toString().padStart(16, '0')}`,
    });

    const first = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(first);
    const firstSource = posted.at(-1);
    if (firstSource?.type !== 'source-available') throw new Error('first source unavailable');
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: first.requestKey,
      noticeId: firstSource.noticeId,
      sessionId: 'native_session_000000000001',
    });
    await flush();

    const second = redirect('request-2', 'playback-2', 'source-2');
    host.acceptRuntimeMessage(started('request-2', 'playback-2', 'source-2'));
    host.acceptRuntimeMessage(second);
    const secondSource = posted.at(-1);
    if (secondSource?.type !== 'source-available') throw new Error('second source unavailable');
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: second.requestKey,
      noticeId: secondSource.noticeId,
      sessionId: 'native_session_000000000002',
    });
    await flush();

    expect(runtimeStop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: 'native_session_000000000002',
    });

    firstStart.resolve(activePlayback(firstStop, completion.promise));
    await flush();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(posted).not.toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: 'native_session_000000000001',
    });

    await host.dispose();
  });

  it('接管就绪后的解码失败使用稳定媒体错误码结束会话', async () => {
    const media = new TestMediaElement();
    const completion = deferred<void>();
    const runtimeStop = vi.fn(async () => undefined);
    const posted: PlexNativeMessage[] = [];
    const host = new PlexNativePlaybackHost({
      createPlaybackRuntime: () => ({
        start: async () =>
          activePlayback(
            vi.fn(async () => undefined),
            completion.promise,
          ),
        stop: runtimeStop,
      }),
      resolveMediaElement: () => media as unknown as HTMLMediaElement,
      postMessage: (message) => posted.push(message),
      readStartSeconds: () => undefined,
      createNoticeId: () => 'notice_id_1234567890',
    });
    const notice = redirect('request-1', 'playback-1', 'source-1');
    host.acceptRuntimeMessage(started('request-1', 'playback-1', 'source-1'));
    host.acceptRuntimeMessage(notice);
    host.acceptPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey: notice.requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: 'native_session_1234567890',
    });
    await flush();

    completion.reject(new BrowserMediaElementError(3));
    await flush();

    expect(runtimeStop).toHaveBeenCalledOnce();
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: 'native_session_1234567890',
      code: 'media_decode_error',
    });
    await host.dispose();
  });
});

const started = (
  requestId: string,
  requestKey: string,
  sourceKey: string,
): PlexRequestStartedNotice => ({
  type: 'shimweave:plex-request-started',
  requestId,
  requestKey,
  sourceKey,
});

const redirect = (
  requestId: string,
  requestKey: string,
  sourceKey: string,
): PlexMediaSourceNotice => ({
  type: 'shimweave:plex-media-source',
  source: {
    sourceId: sourceKey,
    access: { kind: 'direct-http-range', url: 'https://cdn.example/media.mkv' },
    nativePlaybackUrl: 'https://cdn.example/media.mkv',
  },
  metadataPath: '/library/metadata/1',
  mediaIndex: 0,
  partIndex: 0,
  requestId,
  requestKey,
  sourceKey,
});

const control = (
  requestId: string,
  requestKey: string,
  sourceKey: string,
): PlexMediaSourceNotice => ({
  type: 'shimweave:plex-media-source',
  source: {
    sourceId: sourceKey,
    access: {
      kind: 'controlled-http-range',
      url: 'https://plex.example/_shimweave/control/v1/range',
      requestHeaders: { 'X-ShimWeave-Control-Token': 'control_token_12345678901234567890' },
      responseUrlHeader: 'X-ShimWeave-Media-Url',
      expectedStatus: 204,
    },
  },
  metadataPath: '/library/metadata/1',
  mediaIndex: 0,
  partIndex: 0,
  requestId,
  requestKey,
  sourceKey,
});

const activePlayback = (
  stop: () => Promise<void>,
  completion: Promise<void>,
): ActiveBrowserPlayback => ({ descriptor, plan, completion, stop });

const deferred = <T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} => {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
