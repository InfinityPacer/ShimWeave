import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findPlexShakaRuntime,
  PlexNativeHookController,
  type PlexShakaRuntime,
} from './native-hook.js';
import type { PlexNativeMessage } from './native-protocol.js';
import { PLEX_NATIVE_PROTOCOL } from './native-protocol.js';

const startUrl =
  'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0&X-Plex-Playback-Session-Id=playback-1';
const requestKey = 'plex:https://plex.example:/library/metadata/1:0:0:playback-1';
const sourceKey = 'plex:https://plex.example:/library/metadata/1:0:0';

afterEach(() => vi.useRealTimers());

describe('PlexNativeHookController', () => {
  it('本地正常 manifest 完整调用 Shaka 原始 load', async () => {
    const fixture = createRuntime(async () => undefined);
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({ postMessage: (message) => posted.push(message) });
    hook.install(fixture.runtime);

    await fixture.player.load(startUrl);

    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(fixture.player.unload).not.toHaveBeenCalled();
    expect(posted.filter((message) => message.type === 'takeover-start')).toEqual([]);
    hook.dispose();
  });

  it('已确认外部媒体时等待 Host 接管并保留 Shaka 附着', async () => {
    const fixture = createRuntime(async () => {
      throw new Error('manifest rejected');
    });
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    expect(fixture.player.unload).toHaveBeenCalledWith(false);
    expect(fixture.player.getMediaElement()).toBe(fixture.mediaElement);
    expect(takeover).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-start',
      requestKey,
      noticeId: 'notice_id_1234567890',
      sessionId: expect.any(String),
    });
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await expect(loading).resolves.toBeUndefined();
    hook.dispose();
  });

  it('默认接管窗口允许较慢的冷恢复完成', async () => {
    vi.useFakeTimers();
    const fixture = createRuntime(async () => {
      throw new Error('manifest rejected');
    });
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await vi.advanceTimersByTimeAsync(0);
    hook.accept(sourceAvailable());
    await vi.advanceTimersByTimeAsync(0);
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');

    await vi.advanceTimersByTimeAsync(12_000);
    expect(posted.some((message) => message.type === 'takeover-stop')).toBe(false);

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await expect(loading).resolves.toBeUndefined();
    hook.dispose();
  });

  it('Host 失败时沿用首次 Shaka load 的 Plex 错误且不重复请求', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: takeover.sessionId,
      code: 'playback_failed',
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });

    await expect(loading).rejects.toBe(manifestError);
    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-stop',
      sessionId: takeover.sessionId,
    });
    hook.dispose();
  });

  it('接管准备阶段的确定性格式失败交给 Shaka 并阻止立即重复接管', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: takeover.sessionId,
      code: 'media_format_error',
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });

    await expect(loading).rejects.toBe(manifestError);
    expect(fixture.dispatchEvent).toHaveBeenCalledWith({ type: 'error', mediaErrorCode: 4 });
    const retryUrl = startUrl.replace('playback-1', 'playback-2');
    const retryLoading = fixture.player.load(retryUrl);
    hook.accept({
      ...sourceAvailable(),
      requestKey: requestKey.replace('playback-1', 'playback-2'),
    });
    await expect(retryLoading).rejects.toBeInstanceOf(Error);
    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(posted.filter((message) => message.type === 'takeover-start')).toHaveLength(1);
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'blocked-source-retry',
      sourceKey,
    });
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'source-rejected',
      requestKey: requestKey.replace('playback-1', 'playback-2'),
      noticeId: 'notice_id_1234567890',
    });
    hook.dispose();
  });

  it('接管就绪后的确定性解码失败交给 Shaka 并阻止同媒体立即重复接管', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await loading;

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: takeover.sessionId,
      code: 'media_decode_error',
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });
    await flush();

    expect(fixture.dispatchEvent).toHaveBeenCalledWith({ type: 'error', mediaErrorCode: 3 });
    expect(posted.some((message) => message.type === 'takeover-error-unsurfaced')).toBe(false);
    const retryUrl = startUrl.replace('playback-1', 'playback-2');
    await expect(fixture.player.load(retryUrl)).rejects.toBeInstanceOf(Error);
    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(posted.filter((message) => message.type === 'takeover-start')).toHaveLength(1);
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'blocked-source-retry',
      sourceKey,
    });
    hook.dispose();
  });

  it('接管就绪后的非确定性错误不写入同媒体阻断', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await loading;
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: takeover.sessionId,
      code: 'media_worker_remote_error',
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });
    await flush();

    expect(fixture.dispatchEvent).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-error-unsurfaced',
      sessionId: takeover.sessionId,
      code: 'media_worker_remote_error',
    });
    const retryUrl = startUrl.replace('playback-1', 'playback-2');
    const retry = fixture.player.load(retryUrl);
    await flush();
    hook.accept({
      ...sourceAvailable(),
      requestKey: requestKey.replace('playback-1', 'playback-2'),
    });
    await flush();
    expect(posted.filter((message) => message.type === 'takeover-start')).toHaveLength(2);
    retry.catch(() => undefined);
    hook.dispose();
  });

  it('接管就绪后的读取失败交给 Plex 网络错误表面，不阻断重试', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('manifest rejected')));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept(hostMessage('takeover-ready', takeover.sessionId));
    await loading;

    hook.accept(takeoverError(takeover.sessionId, 'media_read_failed'));
    hook.accept(hostMessage('takeover-stopped', takeover.sessionId));
    await flush();

    expect(fixture.dispatchEvent).toHaveBeenCalledExactlyOnceWith({ type: 'error', network: true });
    expect(posted.some((message) => message.type === 'takeover-error-unsurfaced')).toBe(false);
    const retry = fixture.player.load(startUrl.replace('playback-1', 'playback-2'));
    await flush();
    hook.accept({
      ...sourceAvailable(),
      requestKey: requestKey.replace('playback-1', 'playback-2'),
    });
    await flush();
    expect(posted.filter((message) => message.type === 'takeover-start')).toHaveLength(2);
    retry.catch(() => undefined);
    hook.dispose();
  });

  it('接管准备阶段的读取失败同样交给 Plex 网络错误表面', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');

    hook.accept(takeoverError(takeover.sessionId, 'source_expired'));
    hook.accept(hostMessage('takeover-stopped', takeover.sessionId));

    await expect(loading).rejects.toBe(manifestError);
    expect(fixture.dispatchEvent).toHaveBeenCalledExactlyOnceWith({ type: 'error', network: true });
    hook.dispose();
  });

  it('Plex 卸载画面或失败收尾期间已发起新 load 时不报告网络错误', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('manifest rejected')));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const first = posted.find((message) => message.type === 'takeover-start');
    if (first?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept(hostMessage('takeover-ready', first.sessionId));
    await loading;

    hook.accept(takeoverError(first.sessionId, 'media_detached'));
    hook.accept(hostMessage('takeover-stopped', first.sessionId));
    await flush();
    expect(fixture.dispatchEvent).not.toHaveBeenCalled();

    const next = fixture.player.load(startUrl.replace('playback-1', 'playback-2'));
    next.catch(() => undefined);
    await flush();
    hook.accept({
      ...sourceAvailable(),
      requestKey: requestKey.replace('playback-1', 'playback-2'),
    });
    await flush();
    const second = posted.filter((message) => message.type === 'takeover-start').at(1);
    if (second?.type !== 'takeover-start') throw new Error('second takeover was not started');
    hook.accept(takeoverError(second.sessionId, 'media_read_failed'));
    void fixture.player.load(startUrl.replace('playback-1', 'playback-3')).catch(() => undefined);
    hook.accept(hostMessage('takeover-stopped', second.sessionId));
    await flush();

    expect(fixture.dispatchEvent).not.toHaveBeenCalled();
    expect(posted.some((message) => message.type === 'takeover-error-unsurfaced')).toBe(false);
    hook.dispose();
  });

  it('就绪后的错误没能交给 Plex 时请宿主自己提示', async () => {
    for (const [code, failing] of [
      ['media_read_failed', 'missing'],
      ['media_decode_error', 'missing'],
      ['source_expired', 'throws'],
    ] as const) {
      const fixture = createRuntime(async () => Promise.reject(new Error('manifest rejected')));
      if (failing === 'throws') {
        fixture.dispatchEvent.mockImplementation(() => {
          throw new Error('page changed');
        });
      }
      const runtime: PlexShakaRuntime =
        failing === 'missing'
          ? { Player: fixture.runtime.Player, version: fixture.runtime.version }
          : fixture.runtime;
      const posted: PlexNativeMessage[] = [];
      const hook = new PlexNativeHookController({
        postMessage: (message) => posted.push(message),
        rejectionGraceMs: 0,
      });
      hook.install(runtime);
      const loading = fixture.player.load(startUrl);
      await flush();
      hook.accept(sourceAvailable());
      await flush();
      const takeover = posted.find((message) => message.type === 'takeover-start');
      if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
      hook.accept(hostMessage('takeover-ready', takeover.sessionId));
      await loading;

      hook.accept(takeoverError(takeover.sessionId, code));
      hook.accept(hostMessage('takeover-stopped', takeover.sessionId));
      await flush();

      expect(posted.at(-1)).toEqual({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'takeover-error-unsurfaced',
        sessionId: takeover.sessionId,
        code,
      });
      hook.dispose();
    }
  });

  it('同一 Part 的 Plex 重试复用已经建立的接管会话', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('manifest rejected')));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
    });
    hook.install(fixture.runtime);
    const firstLoading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await firstLoading;

    await expect(fixture.player.load(startUrl.replace('playback-1', 'playback-2'))).resolves.toBe(
      undefined,
    );
    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(posted.filter((message) => message.type === 'takeover-stop')).toEqual([]);
    hook.dispose();
  });

  it('两个 Shaka load 并发接管同一 Part 时先停止前一个会话，前一个 load 正常结束', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('load interrupted')));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 60_000,
    });
    hook.install(fixture.runtime);
    const restored = new (fixture.runtime.Player as unknown as new () => typeof fixture.player)();
    const secondUrl = startUrl.replace('playback-1', 'playback-2');
    const firstLoading = fixture.player.load(startUrl);
    const secondLoading = restored.load(secondUrl);
    await flush();

    hook.accept(sourceAvailable());
    await flush();
    const first = posted.find((message) => message.type === 'takeover-start');
    if (first?.type !== 'takeover-start') throw new Error('first takeover was not started');

    hook.accept({
      ...sourceAvailable(),
      requestKey: requestKey.replace('playback-1', 'playback-2'),
      noticeId: 'notice_id_0987654321',
    });
    await flush();
    const stop = posted.find((message) => message.type === 'takeover-stop');
    expect(stop).toMatchObject({ sessionId: first.sessionId });
    expect(posted.filter((message) => message.type === 'takeover-start')).toHaveLength(1);

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: first.sessionId,
    });
    await expect(firstLoading).resolves.toBeUndefined();
    await flush();
    const second = posted.filter((message) => message.type === 'takeover-start')[1];
    if (second?.type !== 'takeover-start') throw new Error('second takeover was not started');
    expect(second.noticeId).toBe('notice_id_0987654321');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: second.sessionId,
    });
    await expect(secondLoading).resolves.toBeUndefined();
    hook.dispose();
  });

  it('接管准备期间同一请求的新通知不被拒绝，沿用旧通知接管', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('load interrupted')));
    const unload = deferredVoid();
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 60_000,
    });
    hook.install(fixture.runtime);
    vi.mocked(fixture.player.unload).mockImplementationOnce(() => unload.promise);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    hook.accept({ ...sourceAvailable(), noticeId: 'notice_id_0987654321' });
    unload.resolve();
    await flush();

    expect(posted.filter((message) => message.type === 'source-rejected')).toEqual([]);
    const takeover = posted.find((message) => message.type === 'takeover-start');
    expect(takeover).toMatchObject({ noticeId: 'notice_id_1234567890' });
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await expect(loading).resolves.toBeUndefined();
    hook.dispose();
  });

  it('停止开始后忽略迟到的 Host ready', async () => {
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId: takeover.sessionId,
      code: 'playback_failed',
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });

    await expect(loading).rejects.toBe(manifestError);
    hook.dispose();
  });

  it('响应身份与当前 Shaka load 不一致时不接管', async () => {
    const fixture = createRuntime(async () => undefined);
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({ postMessage: (message) => posted.push(message) });
    hook.install(fixture.runtime);
    hook.accept({ ...sourceAvailable(), sourceKey: 'plex:other-source' });

    await fixture.player.load(startUrl);
    expect(fixture.player.unload).not.toHaveBeenCalled();
    expect(posted.some((message) => message.type === 'takeover-start')).toBe(false);
    hook.dispose();
  });

  it('没有对应 Shaka load 的迟到媒体源立即要求 Host 释放', () => {
    const fixture = createRuntime(async () => undefined);
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({ postMessage: (message) => posted.push(message) });
    hook.install(fixture.runtime);

    hook.accept(sourceAvailable());

    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'source-rejected',
      requestKey,
      noticeId: 'notice_id_1234567890',
    });
    expect(fixture.player.unload).not.toHaveBeenCalled();
    hook.dispose();
  });

  it('快速切集会等旧媒体停止确认后才启动新 Shaka load', async () => {
    let calls = 0;
    const fixture = createRuntime(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first manifest rejected');
    });
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
    });
    hook.install(fixture.runtime);
    const firstLoading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await firstLoading;

    const nextUrl = startUrl
      .replace('metadata%2F1', 'metadata%2F2')
      .replace('playback-1', 'playback-2');
    const nextLoading = fixture.player.load(nextUrl);
    await flush();
    expect(fixture.originalLoad).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toEqual({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-stop',
      sessionId: takeover.sessionId,
    });

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });
    await expect(nextLoading).resolves.toBeUndefined();
    expect(fixture.originalLoad).toHaveBeenCalledTimes(2);
    hook.dispose();
  });

  it('旧会话停止期间的同 Part 请求不会复用即将释放的结果', async () => {
    const fixture = createRuntime(async () => Promise.reject(new Error('manifest rejected')));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      rejectionGraceMs: 0,
    });
    hook.install(fixture.runtime);
    const firstLoading = fixture.player.load(startUrl);
    await flush();
    hook.accept(sourceAvailable());
    await flush();
    const takeover = posted.find((message) => message.type === 'takeover-start');
    if (takeover?.type !== 'takeover-start') throw new Error('takeover was not started');
    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-ready',
      sessionId: takeover.sessionId,
    });
    await firstLoading;

    const nextUrl = startUrl
      .replace('metadata%2F1', 'metadata%2F2')
      .replace('playback-1', 'playback-2');
    const nextLoading = fixture.player.load(nextUrl).catch(() => undefined);
    await flush();
    const repeatedOldLoading = fixture.player.load(startUrl).catch(() => undefined);
    await flush();
    expect(fixture.originalLoad).toHaveBeenCalledOnce();

    hook.accept({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-stopped',
      sessionId: takeover.sessionId,
    });
    await flush();
    expect(fixture.originalLoad).toHaveBeenCalledTimes(3);

    await Promise.all([nextLoading, repeatedOldLoading]);
    hook.dispose();
  });

  it('Shaka unload 卡住时有界回退到原始 Plex 错误', async () => {
    vi.useFakeTimers();
    const manifestError = new Error('manifest rejected');
    const fixture = createRuntime(async () => Promise.reject(manifestError));
    vi.mocked(fixture.player.unload).mockImplementation(() => new Promise<void>(() => undefined));
    const posted: PlexNativeMessage[] = [];
    const hook = new PlexNativeHookController({
      postMessage: (message) => posted.push(message),
      unloadTimeoutMs: 20,
    });
    hook.install(fixture.runtime);
    const loading = fixture.player.load(startUrl);
    const rejected = expect(loading).rejects.toBe(manifestError);
    await vi.advanceTimersByTimeAsync(0);
    hook.accept(sourceAvailable());
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.player.unload).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(21);

    await rejected;
    expect(posted.some((message) => message.type === 'takeover-start')).toBe(false);
    expect(fixture.mediaElement.dataset.shimweaveNativeSession).toBeUndefined();
    hook.dispose();
  });
});

describe('findPlexShakaRuntime', () => {
  it('按导出能力和工厂结构发现 Shaka，不依赖模块 ID', () => {
    class Player {
      static readonly version = '3.3.1';
      async load(_uri: string, _startTime?: number, _mimeType?: string): Promise<void> {}
      async unload(_initializeMediaSource?: boolean): Promise<void> {}
      getMediaElement(): null {
        return null;
      }
    }
    const exported = { Player, net: { NetworkingEngine: class NetworkingEngine {} } };
    const factory = (): void => {
      void 'shaka.Player';
      void 'NetworkingEngine';
      void 'registerScheme';
    };
    const runtimeRequire = Object.assign(
      (moduleId: string) => (moduleId === 'arbitrary-module' ? exported : undefined),
      { m: { 'arbitrary-module': factory } },
    );

    expect(findPlexShakaRuntime(runtimeRequire)).toEqual({ Player, version: '3.3.1' });
  });

  it('从 Shaka 错误类型构造致命网络错误与媒体错误事件', () => {
    class Player {
      async load(_uri: string): Promise<void> {}
      async unload(): Promise<void> {}
      getMediaElement(): null {
        return null;
      }
    }
    class ShakaError {
      static readonly Severity = { CRITICAL: 2 };
      static readonly Category = { NETWORK: 1, MEDIA: 3 };
      static readonly Code = { HTTP_ERROR: 1002, VIDEO_ERROR: 3016 };
      readonly data: unknown[];
      constructor(
        readonly severity: number,
        readonly category: number,
        readonly code: number,
        ...data: unknown[]
      ) {
        this.data = data;
      }
    }
    class FakeEvent {
      readonly detail: unknown;
      constructor(
        readonly type: string,
        data: Map<string, unknown>,
      ) {
        this.detail = data.get('detail');
      }
    }
    const exported = {
      Player,
      net: { NetworkingEngine: class NetworkingEngine {} },
      util: { Error: ShakaError, FakeEvent },
    };
    const factory = (): void => {
      void 'shaka.Player';
      void 'NetworkingEngine';
      void 'registerScheme';
    };
    const runtime = findPlexShakaRuntime(
      Object.assign(() => exported, { m: { 'arbitrary-module': factory } }),
    );

    expect(runtime?.createNetworkErrorEvent?.()).toMatchObject({
      type: 'error',
      detail: { severity: 2, category: 1, code: 1002, data: [] },
    });
    expect(runtime?.createMediaErrorEvent?.(3)).toMatchObject({
      type: 'error',
      detail: { severity: 2, category: 3, code: 3016, data: [3] },
    });
  });
});

const createRuntime = (load: () => Promise<void>) => {
  const mediaElement = { dataset: {} as DOMStringMap };
  const originalLoad = vi.fn(load);
  const dispatchEvent = vi.fn((_event: { readonly type: string }) => true);
  class Player {
    static readonly version = '3.3.1';
    load(_uri: string, _startTime?: number, _mimeType?: string): Promise<void> {
      return originalLoad();
    }
    async unload(_initializeMediaSource?: boolean): Promise<void> {}
    async attach(_element: typeof mediaElement, _initializeMediaSource?: boolean): Promise<void> {}
    getMediaElement(): typeof mediaElement {
      return mediaElement;
    }
    dispatchEvent(event: { readonly type: string }): boolean {
      return dispatchEvent(event);
    }
  }
  const player = new Player();
  vi.spyOn(player, 'unload');
  vi.spyOn(player, 'attach');
  vi.spyOn(player, 'getMediaElement');
  return {
    mediaElement,
    dispatchEvent,
    originalLoad,
    player,
    runtime: {
      Player: Player as unknown as PlexShakaRuntime['Player'],
      version: Player.version,
      createMediaErrorEvent: (mediaErrorCode: number) => ({ type: 'error', mediaErrorCode }),
      createNetworkErrorEvent: () => ({ type: 'error', network: true }),
    },
  };
};

const sourceAvailable = (): Extract<PlexNativeMessage, { type: 'source-available' }> => ({
  protocol: PLEX_NATIVE_PROTOCOL,
  sender: 'extension-host',
  type: 'source-available',
  requestKey,
  sourceKey,
  noticeId: 'notice_id_1234567890',
});

const hostMessage = (
  type: 'takeover-ready' | 'takeover-stopped',
  sessionId: string,
): PlexNativeMessage => ({
  protocol: PLEX_NATIVE_PROTOCOL,
  sender: 'extension-host',
  type,
  sessionId,
});

const takeoverError = (sessionId: string, code: string): PlexNativeMessage => ({
  protocol: PLEX_NATIVE_PROTOCOL,
  sender: 'extension-host',
  type: 'takeover-error',
  sessionId,
  code,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const deferredVoid = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};
