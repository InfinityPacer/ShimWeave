import type {
  ByteSource,
  MediaDescriptor,
  MediaEngineProvider,
  MediaEngineSession,
  MediaFragmentSink,
} from '@shimweave/contracts';
import { RangeScheduler } from '@shimweave/core';
import { RangeProtocolError } from '@shimweave/io-fetch';
import { describe, expect, it, vi } from 'vitest';
import { DedicatedMediaWorkerHost } from './media-worker-host.js';
import { MEDIA_WORKER_PROTOCOL, type MediaWorkerHostMessage } from './media-worker-protocol.js';

const descriptor: MediaDescriptor = {
  sourceId: 'stable-source',
  container: 'matroska',
  mimeType: 'video/x-matroska',
  durationSeconds: 60,
  tracks: [
    {
      id: '1',
      kind: 'video',
      codec: 'hevc',
      codecString: 'hvc1.2.4.L153.B0',
      codedWidth: 3840,
      codedHeight: 2160,
    },
  ],
};

const outputAudio = {
  codec: 'aac' as const,
  codecString: 'mp4a.40.2',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
  bitrate: 192_000,
};

describe('DedicatedMediaWorkerHost', () => {
  it('在 Worker 内初始化源、探测描述并有序释放会话', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const closeProbe = vi.fn(async () => undefined);
    const closeScheduler = vi.fn(async () => scheduler.close());
    const createSession = vi.fn(() => ({
      describe: async () => descriptor,
      startFragmentStream: async () => {
        throw new Error('not used');
      },
      close: closeProbe,
    }));
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({ mode: 'shared', scheduler, close: closeScheduler }),
      mediaEngine: testEngine(createSession),
    });

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'ready',
      sessionId: 'session',
      schedulerMode: 'shared',
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'stable-source',
        getSize: expect.any(Function),
        read: expect.any(Function),
        close: expect.any(Function),
      }),
    );

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'request' });
    await flush();
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'descriptor',
      requestId: 'request',
      descriptor,
    });

    await host.close();
    expect(closeProbe).toHaveBeenCalledOnce();
    expect(closeScheduler).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toEqual({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
  });

  it('初始化前不探测，且错误响应不回显源地址', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      mediaEngine: testEngine(() => ({
        describe: async () => descriptor,
        startFragmentStream: async () => {
          throw new Error('not used');
        },
        close: async () => undefined,
      })),
    });

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'early' });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource('file:///private/media'),
    });
    await flush();

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'error', requestId: 'early', code: 'not_ready' }),
    );
    expect(JSON.stringify(messages)).not.toContain('file:///private/media');
    await host.close();
  });

  it('初始化失败时只返回稳定错误，不泄漏签名 URL', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      mediaEngine: testEngine(() => ({
        describe: async () => descriptor,
        startFragmentStream: async () => {
          throw new Error('not used');
        },
        close: async () => undefined,
      })),
      createScheduler: async () => {
        throw new Error('https://cdn.example/media?token=secret');
      },
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource('https://cdn.example/media?token=secret'),
    });
    await flush();

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'initialization_failed' }),
    );
    expect(JSON.stringify(messages)).not.toContain('token=secret');
  });

  it('替换引擎创建失败时释放运行时并保持稳定错误边界', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const closeScheduler = vi.fn(async () => scheduler.close());
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({ mode: 'local', scheduler, close: closeScheduler }),
      mediaEngine: {
        createSession: () => {
          throw new Error('https://cdn.example/media?token=secret');
        },
      },
    });

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource('https://cdn.example/media?token=secret'),
    });
    await waitFor(() => messages.some((message) => message.type === 'error'));

    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'error',
      code: 'initialization_failed',
      message: 'Media worker initialization failed',
    });
    expect(JSON.stringify(messages)).not.toContain('token=secret');
    expect(closeScheduler).toHaveBeenCalledOnce();
  });

  it('探测失败时返回 Range 协议分类而不回显异常消息', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const protocolFailure = new RangeProtocolError('unexpected_status', { status: 403 });
    const wrapped = new Error('https://cdn.example/media?token=secret', {
      cause: protocolFailure,
    });
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () => Promise.reject(wrapped),
        startFragmentStream: async () => Promise.reject(new Error('not used')),
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource('https://cdn.example/media?token=secret'),
    });
    await flush();

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'probe' });
    await flush();

    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'error',
      code: 'probe_failed',
      message: 'Error>RangeProtocolError.unexpected_status.status_403',
      requestId: 'probe',
    });
    expect(JSON.stringify(messages)).not.toContain('token=secret');
    await host.close();
  });

  it('Range 响应体不完整时仅返回安全的长度证据', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () =>
          Promise.reject(
            new RangeProtocolError('body_length_mismatch', { expected: 4096, actual: 1024 }),
          ),
        startFragmentStream: async () => Promise.reject(new Error('not used')),
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'probe' });
    await flush();

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'probe_failed',
        message: 'RangeProtocolError.body_length_mismatch.expected_4096.actual_1024',
      }),
    );
    await host.close();
  });

  it('普通异常只返回不含地址与凭据形态的安全说明', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () => Promise.reject(new TypeError('options.output must be pending.')),
        startFragmentStream: async () => Promise.reject(new Error('not used')),
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'probe' });
    await flush();

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'probe_failed',
        message: 'TypeError.options_output_must_be_pending',
      }),
    );
    await host.close();
  });

  it('发送 MIME 后逐块等待页面 ACK，并在完成后释放流槽位', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const transfers: Transferable[][] = [];
    const scheduler = new RangeScheduler();
    const conversion = deferred<void>();
    const startFragmentStream = vi.fn(async (sink: MediaFragmentSink) => {
      await sink.write(new Uint8Array([1, 2, 3]));
      return {
        mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        timelineOffsetSeconds: 12,
        initialPositionSeconds: 3,
        completion: conversion.promise,
        cancel: async () => conversion.resolve(undefined),
      };
    });
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message, transfer = []) => {
        messages.push(message);
        transfers.push(transfer);
      },
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () => descriptor,
        startFragmentStream,
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId: 'descriptor' });
    await flush();

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'start-stream',
      requestId: 'stream',
      startSeconds: 15,
    });
    await flush();

    expect(startFragmentStream).toHaveBeenCalledWith(expect.anything(), { startSeconds: 15 });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'stream-ready',
        requestId: 'stream',
        durationSeconds: 60,
        timelineOffsetSeconds: 12,
        initialPositionSeconds: 3,
      }),
    );
    const chunk = messages.find((message) => message.type === 'stream-chunk');
    expect(chunk).toEqual(expect.objectContaining({ requestId: 'stream', chunkId: '0' }));
    const chunkIndex = messages.indexOf(chunk as MediaWorkerHostMessage);
    expect(transfers[chunkIndex]).toEqual([
      expect.objectContaining({ byteLength: 3 }) as ArrayBuffer,
    ]);
    expect(messages).not.toContainEqual(
      expect.objectContaining({ type: 'stream-complete', requestId: 'stream' }),
    );

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'append-ack',
      requestId: 'stream',
      chunkId: '0',
    });
    conversion.resolve(undefined);
    await flush();

    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: 'stream',
    });
    await host.close();
  });

  it('取消会打断等待 ACK 的媒体流且不返回失败', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const conversion = deferred<void>();
    const cancel = vi.fn(async () => conversion.resolve(undefined));
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () => descriptor,
        startFragmentStream: async (sink) => {
          await sink.write(new Uint8Array([1]));
          return {
            mimeType: 'video/mp4',
            timelineOffsetSeconds: 0,
            initialPositionSeconds: 0,
            completion: conversion.promise,
            cancel,
          };
        },
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();
    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'start-stream', requestId: 'stream' });
    await flush();

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: 'stream',
    });
    await waitFor(() =>
      messages.some(
        (message) => message.type === 'stream-complete' && message.requestId === 'stream',
      ),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: 'stream',
    });
    expect(messages).not.toContainEqual(expect.objectContaining({ code: 'stream_failed' }));
    await host.close();
  });

  it('音频转换先按输入 codec 准备本地 provider，再启动媒体流', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const prepareCodecs = vi.fn(async () => undefined);
    const startFragmentStream = vi.fn(async () => ({
      mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
      completion: Promise.resolve(),
      cancel: async () => undefined,
    }));
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(() => ({
        describe: async () => descriptor,
        prepareCodecs,
        startFragmentStream,
        close: async () => undefined,
      })),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'start-stream',
      requestId: 'transcode',
      outputAudio,
      videoTrackId: '1',
      audioTrackId: '2',
    });
    await flush();

    expect(prepareCodecs).toHaveBeenCalledWith({ outputAudio, audioTrackId: '2' });
    expect(prepareCodecs.mock.invocationCallOrder[0]).toBeLessThan(
      startFragmentStream.mock.invocationCallOrder[0] ?? 0,
    );
    expect(startFragmentStream).toHaveBeenCalledWith(expect.anything(), {
      outputAudio,
      videoTrackId: '1',
      audioTrackId: '2',
    });
    await host.close();
  });

  it('媒体读取失败后重建输入会话并允许同一 Worker 重试', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const failedClose = vi.fn(async () => undefined);
    const recoveredCompletion = deferred<void>();
    const recoveredCancel = vi.fn(async () => recoveredCompletion.resolve(undefined));
    const createMediaSession = vi
      .fn()
      .mockReturnValueOnce({
        describe: async () => descriptor,
        startFragmentStream: async () => {
          const error = new Error('https://cdn.example/media?token=secret');
          error.name = 'TransientNetworkError';
          throw error;
        },
        close: failedClose,
      })
      .mockReturnValueOnce({
        describe: async () => descriptor,
        startFragmentStream: async () => ({
          mimeType: 'video/mp4',
          timelineOffsetSeconds: 0,
          initialPositionSeconds: 0,
          completion: recoveredCompletion.promise,
          cancel: recoveredCancel,
        }),
        close: async () => undefined,
      });
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(createMediaSession),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'start-stream', requestId: 'failed' });
    await waitFor(() =>
      messages.some((message) => message.type === 'error' && message.requestId === 'failed'),
    );
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'error',
      code: 'stream_failed',
      message: 'TransientNetworkError',
      requestId: 'failed',
    });
    expect(JSON.stringify(messages)).not.toContain('token=secret');
    expect(failedClose).toHaveBeenCalledOnce();
    expect(createMediaSession).toHaveBeenCalledTimes(2);

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'start-stream', requestId: 'recovered' });
    await flush();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'stream-ready', requestId: 'recovered' }),
    );

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: 'recovered',
    });
    await flush();
    expect(recoveredCancel).toHaveBeenCalledOnce();
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: 'recovered',
    });
    await host.close();
  });

  it('建流期间取消会关闭未就绪输入并在重建后释放流槽位', async () => {
    const messages: MediaWorkerHostMessage[] = [];
    const scheduler = new RangeScheduler();
    const opening = deferred<never>();
    const openingClose = vi.fn(async () => opening.reject(new Error('input closed')));
    const recoveredCompletion = deferred<void>();
    const createMediaSession = vi
      .fn()
      .mockReturnValueOnce({
        describe: async () => descriptor,
        startFragmentStream: () => opening.promise,
        close: openingClose,
      })
      .mockReturnValueOnce({
        describe: async () => descriptor,
        startFragmentStream: async () => ({
          mimeType: 'video/mp4',
          timelineOffsetSeconds: 0,
          initialPositionSeconds: 0,
          completion: recoveredCompletion.promise,
          cancel: async () => recoveredCompletion.resolve(undefined),
        }),
        close: async () => undefined,
      });
    const host = new DedicatedMediaWorkerHost({
      postMessage: (message) => messages.push(message),
      createScheduler: async () => ({
        mode: 'local',
        scheduler,
        close: () => scheduler.close(),
      }),
      mediaEngine: testEngine(createMediaSession),
    });
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: 'session',
      source: directSource(),
    });
    await flush();
    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'start-stream', requestId: 'opening' });
    await flush();

    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: 'opening',
    });
    await waitFor(() =>
      messages.some(
        (message) => message.type === 'stream-complete' && message.requestId === 'opening',
      ),
    );
    expect(openingClose).toHaveBeenCalledOnce();
    expect(createMediaSession).toHaveBeenCalledTimes(2);
    expect(messages).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: 'opening',
    });
    expect(messages).not.toContainEqual(
      expect.objectContaining({ type: 'error', requestId: 'opening' }),
    );

    host.receive({ protocol: MEDIA_WORKER_PROTOCOL, type: 'start-stream', requestId: 'recovered' });
    await flush();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'stream-ready', requestId: 'recovered' }),
    );
    host.receive({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: 'recovered',
    });
    await flush();
    await host.close();
  });
});

const directSource = (url = 'https://cdn.example/media') => ({
  sourceId: 'stable-source',
  access: { kind: 'direct-http-range' as const, url },
});

type TestMediaSession = Omit<MediaEngineSession, 'prepareCodecs'> &
  Partial<Pick<MediaEngineSession, 'prepareCodecs'>>;

const testEngine = (
  createSession: (source: ByteSource) => TestMediaSession,
): MediaEngineProvider => ({
  createSession: (source) => ({
    prepareCodecs: async () => undefined,
    ...createSession(source),
  }),
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 64; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
