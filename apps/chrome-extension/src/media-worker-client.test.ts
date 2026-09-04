import type { MediaDescriptor } from '@shimweave/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaWorkerClient,
  MediaWorkerClientClosedError,
  MediaWorkerReadyTimeoutError,
  MediaWorkerRemoteError,
  MediaWorkerStreamCancelledError,
} from './media-worker-client.js';
import { MEDIA_WORKER_PROTOCOL } from './media-worker-protocol.js';

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Array<{ message: unknown; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }
}

const descriptor: MediaDescriptor = {
  sourceId: 'stable-source',
  container: 'matroska',
  tracks: [{ id: '1', kind: 'video', codec: 'hevc' }],
};

afterEach(() => vi.useRealTimers());

describe('MediaWorkerClient', () => {
  it('把 SharedWorker 端口转移给 Dedicated Worker 并接收结构化描述', async () => {
    const worker = new TestWorker();
    const channel = new MessageChannel();
    const client = new MediaWorkerClient({
      source: {
        sourceId: 'stable-source',
        access: {
          kind: 'controlled-http-range',
          url: 'https://control.example/range',
          requestHeaders: { Authorization: 'Bearer opaque_control_token_123456' },
          responseUrlHeader: 'X-Media-Url',
          expectedStatus: 204,
        },
      },
      sessionId: 'session',
      workerURL: 'chrome-extension://test/media-worker.js',
      coordinatorURL: 'chrome-extension://test/range-coordinator.js',
      createWorker: () => worker,
      createSharedWorker: () => ({ port: channel.port1 }),
    });

    expect(worker.sent[0]?.transfer).toEqual([channel.port1]);
    expect(worker.sent[0]?.message).toEqual(
      expect.objectContaining({
        type: 'init',
        sessionId: 'session',
        source: {
          sourceId: 'stable-source',
          access: {
            kind: 'controlled-http-range',
            url: 'https://control.example/range',
            requestHeaders: { Authorization: 'Bearer opaque_control_token_123456' },
            responseUrlHeader: 'X-Media-Url',
            expectedStatus: 204,
          },
        },
        coordinatorPort: channel.port1,
      }),
    );
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'ready',
      sessionId: 'session',
      schedulerMode: 'shared',
    });
    await expect(client.whenReady()).resolves.toBeUndefined();
    expect(client.schedulerMode).toBe('shared');

    const pending = client.describe();
    await Promise.resolve();
    const request = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'descriptor',
      requestId: request.requestId,
      descriptor,
    });
    await expect(pending).resolves.toEqual(descriptor);

    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await expect(closing).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
  });

  it('SharedWorker 构造失败时允许 Dedicated Worker 使用本地调度', async () => {
    const worker = new TestWorker();
    const client = new MediaWorkerClient({
      source: directSource(),
      sessionId: 'session',
      workerURL: 'chrome-extension://test/media-worker.js',
      createWorker: () => worker,
      createSharedWorker: () => {
        throw new Error('SharedWorker unavailable');
      },
    });

    expect(worker.sent[0]?.transfer).toEqual([]);
    expect(worker.sent[0]?.message).not.toHaveProperty('coordinatorPort');
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'ready',
      sessionId: 'session',
      schedulerMode: 'local',
    });
    await expect(client.whenReady()).resolves.toBeUndefined();
    expect(client.schedulerMode).toBe('local');

    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('关闭时拒绝未完成请求，Worker 不确认也会有界终止', async () => {
    vi.useFakeTimers();
    const worker = new TestWorker();
    const client = new MediaWorkerClient({
      source: directSource(),
      sessionId: 'session',
      workerURL: 'chrome-extension://test/media-worker.js',
      createWorker: () => worker,
      createSharedWorker: () => undefined as never,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'ready',
      sessionId: 'session',
      schedulerMode: 'local',
    });
    await client.whenReady();
    const descriptorPromise = client.describe();
    const closing = client.close();

    await expect(descriptorPromise).rejects.toBeInstanceOf(MediaWorkerClientClosedError);
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(closing).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
  });

  it('握手超时后拒绝会话并终止 Worker', async () => {
    vi.useFakeTimers();
    const worker = new TestWorker();
    const client = new MediaWorkerClient({
      source: directSource(),
      sessionId: 'session',
      workerURL: 'chrome-extension://test/media-worker.js',
      createWorker: () => worker,
      createSharedWorker: () => undefined as never,
      readyTimeoutMs: 10,
    });
    const ready = expect(client.whenReady()).rejects.toBeInstanceOf(MediaWorkerReadyTimeoutError);

    await vi.advanceTimersByTimeAsync(11);
    await ready;
    expect(worker.terminated).toBe(true);
  });

  it('只在消费者确认媒体块后向 Worker 发送 ACK', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();
    const opening = client.startStream();
    await Promise.resolve();
    const request = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: request.requestId,
      mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
      durationSeconds: 1_200,
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
    });
    const stream = await opening;
    expect(stream.durationSeconds).toBe(1_200);
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-chunk',
      requestId: request.requestId,
      chunkId: 'chunk',
      bytes: buffer,
    });

    const chunk = await stream.read();
    expect(chunk?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(worker.sent.map((item) => item.message)).not.toContainEqual(
      expect.objectContaining({ type: 'append-ack' }),
    );

    chunk?.acknowledge();
    expect(worker.sent.map((item) => item.message)).toContainEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'append-ack',
      requestId: request.requestId,
      chunkId: 'chunk',
    });

    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: request.requestId,
    });
    await expect(stream.completion).resolves.toBeUndefined();
    await expect(stream.read()).resolves.toBeUndefined();
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('取消流后等待 Worker 完成确认并丢弃迟到媒体块', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();
    const opening = client.startStream();
    await Promise.resolve();
    const request = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: request.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
    });
    const stream = await opening;

    const cancelled = stream.cancel();
    expect(worker.sent.at(-1)?.message).toEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: request.requestId,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-chunk',
      requestId: request.requestId,
      chunkId: 'late',
      bytes: new Uint8Array([9]).buffer,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: request.requestId,
    });

    await expect(cancelled).resolves.toBeUndefined();
    await expect(stream.read()).resolves.toBeUndefined();
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('校验并透传 Seek 起点及重建后的时间轴', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();

    await expect(client.startStream({ startSeconds: -1 })).rejects.toBeInstanceOf(RangeError);
    const opening = client.startStream({
      startSeconds: 42.5,
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
    });
    await Promise.resolve();
    const request = worker.sent.at(-1)?.message as { requestId: string };
    expect(worker.sent.at(-1)?.message).toEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'start-stream',
      requestId: request.requestId,
      startSeconds: 42.5,
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
    });

    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: request.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: -0.5,
      initialPositionSeconds: 43,
    });
    const stream = await opening;
    expect(stream.timelineOffsetSeconds).toBe(-0.5);
    expect(stream.initialPositionSeconds).toBe(43);

    const cancelled = stream.cancel();
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: request.requestId,
    });
    await cancelled;
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('流建立期间可取消并在 Worker 释放后立即开始新的 Seek', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();

    const opening = client.startStream({ startSeconds: 20 });
    await Promise.resolve();
    const first = worker.sent.at(-1)?.message as { requestId: string };
    const cancelled = client.cancelActiveStream();
    expect(worker.sent.at(-1)?.message).toEqual({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'cancel-stream',
      requestId: first.requestId,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: first.requestId,
    });
    await expect(cancelled).resolves.toBeUndefined();
    await expect(opening).rejects.toBeInstanceOf(MediaWorkerStreamCancelledError);

    const secondOpening = client.startStream({ startSeconds: 40 });
    await Promise.resolve();
    const second = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: second.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 35,
      initialPositionSeconds: 5,
    });
    const secondStream = await secondOpening;
    const secondCancelled = secondStream.cancel();
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: second.requestId,
    });
    await secondCancelled;
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('拒绝非有限或负的 Seek 起点且不向 Worker 发起请求', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();
    const sentBefore = worker.sent.length;

    for (const startSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      await expect(client.startStream({ startSeconds })).rejects.toBeInstanceOf(RangeError);
    }

    expect(worker.sent).toHaveLength(sentBefore);
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('结束旧流后隔离迟到块并允许立即启动新流', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();

    const openingA = client.startStream();
    await Promise.resolve();
    const requestA = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: requestA.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
    });
    const streamA = await openingA;
    const cancelledA = streamA.cancel();
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-chunk',
      requestId: requestA.requestId,
      chunkId: 'late-a',
      bytes: new Uint8Array([7]).buffer,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: requestA.requestId,
    });
    await cancelledA;
    await expect(streamA.read()).resolves.toBeUndefined();

    const openingB = client.startStream();
    await Promise.resolve();
    const requestB = worker.sent.at(-1)?.message as { requestId: string };
    expect(requestB.requestId).not.toBe(requestA.requestId);
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: requestB.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
    });
    const streamB = await openingB;
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-chunk',
      requestId: requestA.requestId,
      chunkId: 'late-a-after-b',
      bytes: new Uint8Array([8]).buffer,
    });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-chunk',
      requestId: requestB.requestId,
      chunkId: 'b',
      bytes: new Uint8Array([9]).buffer,
    });
    await expect(streamB.read()).resolves.toMatchObject({ bytes: new Uint8Array([9]) });
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: requestB.requestId,
    });
    await expect(streamB.completion).resolves.toBeUndefined();
    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });

  it('远端流失败会释放客户端流槽位并允许立即重试', async () => {
    const worker = new TestWorker();
    const client = readyClient(worker);
    await client.whenReady();

    const failedOpening = client.startStream();
    await Promise.resolve();
    const failed = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'error',
      requestId: failed.requestId,
      code: 'stream_failed',
      message: 'Media stream failed',
    });
    await expect(failedOpening).rejects.toBeInstanceOf(MediaWorkerRemoteError);

    const recoveredOpening = client.startStream();
    await Promise.resolve();
    const recovered = worker.sent.at(-1)?.message as { requestId: string };
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-ready',
      requestId: recovered.requestId,
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
    });
    const recoveredStream = await recoveredOpening;
    const cancelled = recoveredStream.cancel();
    worker.emit({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'stream-complete',
      requestId: recovered.requestId,
    });
    await cancelled;

    const closing = client.close();
    worker.emit({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    await closing;
  });
});

const readyClient = (worker: TestWorker): MediaWorkerClient => {
  const client = new MediaWorkerClient({
    source: directSource(),
    sessionId: 'session',
    workerURL: 'chrome-extension://test/media-worker.js',
    createWorker: () => worker,
    createSharedWorker: () => undefined as never,
  });
  worker.emit({
    protocol: MEDIA_WORKER_PROTOCOL,
    type: 'ready',
    sessionId: 'session',
    schedulerMode: 'local',
  });
  return client;
};

const directSource = () => ({
  sourceId: 'stable-source',
  access: { kind: 'direct-http-range' as const, url: 'https://cdn.example/media' },
});
