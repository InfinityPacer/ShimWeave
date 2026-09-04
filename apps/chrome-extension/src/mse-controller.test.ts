import { describe, expect, it, vi } from 'vitest';
import type { MediaWorkerStream, MediaWorkerStreamChunk } from './media-worker-client.js';
import {
  MseBufferQuotaExceededError,
  MsePlaybackController,
  MseSeekTargetUnavailableError,
  MseTypeUnsupportedError,
} from './mse-controller.js';

class TestSourceBuffer extends EventTarget {
  mode: AppendMode = 'segments';
  timestampOffset = 0;
  updating = false;
  buffered: TimeRanges = ranges([]);
  readonly appends: Uint8Array[] = [];
  readonly removals: Array<[number, number]> = [];
  appendAttempts = 0;
  quotaFailures = 0;

  constructor(private readonly appendRanges: Array<Array<[number, number]>> = []) {
    super();
  }

  appendBuffer(bytes: BufferSource): void {
    this.appendAttempts += 1;
    if (this.quotaFailures > 0) {
      this.quotaFailures -= 1;
      throw new DOMException('quota exhausted', 'QuotaExceededError');
    }
    this.updating = true;
    const view = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
    this.appends.push(Uint8Array.from(view));
    this.buffered = ranges(
      (this.appendRanges.shift() ?? [[0, 100]]).map(([start, end]) => [
        start + this.timestampOffset,
        end + this.timestampOffset,
      ]),
    );
  }

  remove(start: number, end: number): void {
    this.updating = true;
    this.removals.push([start, end]);
    const retained: Array<[number, number]> = [];
    for (let index = 0; index < this.buffered.length; index++) {
      const rangeStart = this.buffered.start(index);
      const rangeEnd = this.buffered.end(index);
      if (rangeEnd <= start || rangeStart >= end) {
        retained.push([rangeStart, rangeEnd]);
        continue;
      }
      if (rangeStart < start) retained.push([rangeStart, start]);
      if (rangeEnd > end) retained.push([end, rangeEnd]);
    }
    this.buffered = ranges(retained);
  }

  finish(): void {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }
}

class TestMediaSource extends EventTarget {
  readyState: ReadyState;
  duration = Number.NaN;
  ended = false;

  constructor(
    readonly sourceBuffer: TestSourceBuffer,
    readyState: ReadyState = 'open',
  ) {
    super();
    this.readyState = readyState;
  }

  addSourceBuffer(): SourceBuffer {
    return this.sourceBuffer as unknown as SourceBuffer;
  }

  endOfStream(): void {
    this.ended = true;
    this.readyState = 'ended';
  }
}

class TestMediaElement extends EventTarget {
  src = '';
  currentTime = 60;
  readyState = 1;
  paused = true;
  readonly play = vi.fn(async () => {
    this.paused = false;
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly load = vi.fn();

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

describe('MsePlaybackController', () => {
  it('MediaSource open 后设置 Worker 提供的完整媒体时长', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer, 'closed');
    const mediaElement = new TestMediaElement();
    const stream = createStream([], undefined, { durationSeconds: 1_200 });
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:duration',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
    });

    const opening = controller.start(stream);
    expect(mediaSource.duration).toBeNaN();
    mediaSource.readyState = 'open';
    mediaSource.dispatchEvent(new Event('sourceopen'));
    const playback = await opening;

    expect(mediaSource.duration).toBe(1_200);
    await playback.stop();
  });

  it('只在 append 和旧缓冲淘汰完成后 ACK 媒体块', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const acknowledge = vi.fn();
    const stream = createStream([{ bytes: new Uint8Array([1, 2, 3]), acknowledge }], undefined, {
      initialPositionSeconds: 60,
    });
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedBehindSeconds: 30,
    });

    const playback = await controller.start(stream);
    await flush();
    expect(sourceBuffer.appends).toEqual([new Uint8Array([1, 2, 3])]);
    expect(acknowledge).not.toHaveBeenCalled();

    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.removals).toEqual([[0, 30]]);
    expect(acknowledge).not.toHaveBeenCalled();

    sourceBuffer.finish();
    await playback.completion;
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(mediaElement.play).toHaveBeenCalledOnce();
    expect(mediaSource.ended).toBe(true);
    await playback.stop();
  });

  it('约 973 秒续播仍向播放器暴露原媒体绝对时间', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const stream = createStream([{ bytes: new Uint8Array([1]), acknowledge: vi.fn() }], undefined, {
      timelineOffsetSeconds: 970,
      initialPositionSeconds: 3,
    });
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:seek',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
    });

    const playback = await controller.start(stream);
    await flush();
    expect(mediaElement.currentTime).toBe(60);
    expect(mediaElement.play).not.toHaveBeenCalled();

    sourceBuffer.finish();
    await playback.completion;
    expect(mediaElement.currentTime).toBe(973);
    expect(mediaElement.play).toHaveBeenCalledOnce();
    await playback.stop();
  });

  it('等待媒体元数据可用后再应用 Seek 位置', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    mediaElement.readyState = 0;
    const stream = createStream([{ bytes: new Uint8Array([1]), acknowledge: vi.fn() }], undefined, {
      timelineOffsetSeconds: 30,
      initialPositionSeconds: 7,
    });
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:metadata',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(mediaElement.currentTime).toBe(60);
    expect(mediaElement.play).not.toHaveBeenCalled();

    mediaElement.readyState = 1;
    mediaElement.dispatchEvent(new Event('loadedmetadata'));
    await flush();
    expect(mediaElement.currentTime).toBe(37);
    expect(mediaElement.play).toHaveBeenCalledOnce();
    await playback.completion;
    await playback.stop();
  });

  it('初始化段不含目标位置时等待媒体分片再起播', async () => {
    const sourceBuffer = new TestSourceBuffer([[], [[0, 10]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const firstAck = vi.fn();
    const secondAck = vi.fn();
    const stream = createStream(
      [
        { bytes: new Uint8Array([1]), acknowledge: firstAck },
        { bytes: new Uint8Array([2]), acknowledge: secondAck },
      ],
      undefined,
      { timelineOffsetSeconds: 30, initialPositionSeconds: 7 },
    );
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:fragment',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBehindSeconds: 2,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(firstAck).toHaveBeenCalledOnce();
    expect(mediaElement.play).not.toHaveBeenCalled();
    expect(sourceBuffer.appends).toEqual([new Uint8Array([1]), new Uint8Array([2])]);

    sourceBuffer.finish();
    await playback.completion;
    expect(secondAck).toHaveBeenCalledOnce();
    expect(sourceBuffer.removals).toEqual([]);
    expect(mediaElement.currentTime).toBe(37);
    expect(mediaElement.play).toHaveBeenCalledOnce();
    await playback.stop();
  });

  it('目标位置被旧缓冲淘汰后仍持续回收后续媒体块', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 10]], [[0, 70]], [[10, 100]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    mediaElement.currentTime = 0;
    const secondRead = deferred<void>();
    const thirdRead = deferred<void>();
    const acknowledgements = [vi.fn(), vi.fn(), vi.fn()];
    let readIndex = 0;
    const stream: MediaWorkerStream = {
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
      completion: Promise.resolve(),
      read: async () => {
        const index = readIndex++;
        if (index === 1) await secondRead.promise;
        if (index === 2) await thirdRead.promise;
        if (index >= acknowledgements.length) return undefined;
        return {
          bytes: new Uint8Array([index + 1]),
          acknowledge: acknowledgements[index] as () => void,
        };
      },
      cancel: vi.fn(async () => undefined),
    };
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:eviction',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBehindSeconds: 30,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(acknowledgements[0]).toHaveBeenCalledOnce();

    mediaElement.currentTime = 40;
    secondRead.resolve();
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.removals).toEqual([[0, 10]]);
    sourceBuffer.finish();
    await flush();

    mediaElement.currentTime = 70;
    thirdRead.resolve();
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.removals).toEqual([
      [0, 10],
      [10, 40],
    ]);
    sourceBuffer.finish();
    await playback.completion;
    expect(acknowledgements.every((acknowledge) => acknowledge.mock.calls.length === 1)).toBe(true);
    await playback.stop();
  });

  it('高码率缓冲达到字节上限时优先清理已播完分片', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 10]], [[0, 20]], [[10, 30]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    mediaElement.currentTime = 0;
    const acknowledgements = [vi.fn(), vi.fn(), vi.fn()];
    const stream = createStream(
      acknowledgements.map((acknowledge) => ({ bytes: new Uint8Array(60), acknowledge })),
    );
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:byte-budget',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBehindSeconds: 30,
      maxBufferedBytes: 100,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.appends).toHaveLength(2);
    expect(sourceBuffer.removals).toEqual([]);

    mediaElement.currentTime = 15;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(sourceBuffer.removals).toEqual([[0, 10]]);
    expect(sourceBuffer.appends).toHaveLength(2);

    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.appends).toHaveLength(3);
    sourceBuffer.finish();
    await flush();
    mediaElement.currentTime = 25;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(sourceBuffer.removals).toEqual([
      [0, 10],
      [10, 20],
    ]);
    sourceBuffer.finish();
    await playback.completion;
    expect(acknowledgements.every((acknowledge) => acknowledge.mock.calls.length === 1)).toBe(true);
    await playback.stop();
  });

  it('单个高码率分片超过预算时仍保留一个前向分片供播放推进', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 10]], [[0, 20]], [[10, 30]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const acknowledgements = [vi.fn(), vi.fn(), vi.fn()];
    const stream = createStream(
      acknowledgements.map((acknowledge) => ({ bytes: new Uint8Array(120), acknowledge })),
    );
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:oversized-fragment',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBytes: 100,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    sourceBuffer.finish();
    await flush();

    expect(sourceBuffer.appends).toHaveLength(2);
    expect(mediaElement.play).toHaveBeenCalledOnce();

    mediaElement.currentTime = 15;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    await flush();
    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.appends).toHaveLength(3);
    await playback.stop();
  });

  it('字节压力清理停在完整旧分片边界而不切割长当前分片', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 20]], [[0, 100]], [[20, 120]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    mediaElement.currentTime = 0;
    const stream = createStream([
      { bytes: new Uint8Array(60), acknowledge: vi.fn() },
      { bytes: new Uint8Array(60), acknowledge: vi.fn() },
      { bytes: new Uint8Array(60), acknowledge: vi.fn() },
    ]);
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:fragment-boundary',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBehindSeconds: 30,
      maxBufferedBytes: 100,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    sourceBuffer.finish();
    await flush();

    mediaElement.currentTime = 70;
    mediaElement.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(sourceBuffer.removals).toEqual([[0, 20]]);

    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.appends).toHaveLength(3);
    await playback.stop();
  });

  it('续播目标尚未缓冲时不让字节预算形成等待饥饿', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 10]], [[0, 20]], [[0, 30]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const acknowledgements = [vi.fn(), vi.fn(), vi.fn()];
    const stream = createStream(
      acknowledgements.map((acknowledge) => ({ bytes: new Uint8Array(60), acknowledge })),
      undefined,
      { initialPositionSeconds: 25 },
    );
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:byte-budget-preroll',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBytes: 100,
    });

    const playback = await controller.start(stream);
    for (let index = 0; index < 3; index++) {
      await flush();
      sourceBuffer.finish();
    }
    await flush();

    expect(sourceBuffer.appends).toHaveLength(3);
    expect(mediaElement.currentTime).toBe(25);
    expect(mediaElement.play).toHaveBeenCalledOnce();
    expect(acknowledgements.every((acknowledge) => acknowledge.mock.calls.length === 1)).toBe(true);

    await playback.stop();
    await playback.completion;
  });

  it('流结束仍未包含目标位置时返回稳定 Seek 错误', async () => {
    const sourceBuffer = new TestSourceBuffer([[], [[0, 5]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const cancel = vi.fn(async () => undefined);
    const stream = createStream(
      [
        { bytes: new Uint8Array([1]), acknowledge: vi.fn() },
        { bytes: new Uint8Array([2]), acknowledge: vi.fn() },
      ],
      cancel,
      { initialPositionSeconds: 7 },
    );
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:missing-target',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    sourceBuffer.finish();
    await expect(playback.completion).rejects.toMatchObject({
      constructor: MseSeekTargetUnavailableError,
      targetSeconds: 7,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mediaSource.ended).toBe(false);
    expect(mediaElement.src).toBe('');
  });

  it('MSE 配额不足时淘汰旧缓冲并只重试当前媒体块一次', async () => {
    const sourceBuffer = new TestSourceBuffer([[[0, 100]], [[30, 120]]]);
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    mediaElement.currentTime = 0;
    const secondRead = deferred<void>();
    const acknowledgements = [vi.fn(), vi.fn()];
    let readIndex = 0;
    const stream: MediaWorkerStream = {
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
      completion: Promise.resolve(),
      read: async () => {
        const index = readIndex++;
        if (index === 1) await secondRead.promise;
        if (index >= acknowledgements.length) return undefined;
        return {
          bytes: new Uint8Array([index + 1]),
          acknowledge: acknowledgements[index] as () => void,
        };
      },
      cancel: vi.fn(async () => undefined),
    };
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:quota-retry',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
      maxBufferedBehindSeconds: 30,
    });

    const playback = await controller.start(stream);
    await flush();
    sourceBuffer.finish();
    await flush();
    mediaElement.currentTime = 60;
    sourceBuffer.quotaFailures = 1;
    secondRead.resolve();
    await flush();
    expect(sourceBuffer.removals).toEqual([[0, 30]]);
    sourceBuffer.finish();
    await flush();
    expect(sourceBuffer.appendAttempts).toBe(3);
    sourceBuffer.finish();
    await playback.completion;
    expect(acknowledgements.every((acknowledge) => acknowledge.mock.calls.length === 1)).toBe(true);
    await playback.stop();
  });

  it('没有可淘汰旧缓冲时将 MSE 配额失败显式返回', async () => {
    const sourceBuffer = new TestSourceBuffer();
    sourceBuffer.quotaFailures = 1;
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const cancel = vi.fn(async () => undefined);
    const stream = createStream([{ bytes: new Uint8Array([1]), acknowledge: vi.fn() }], cancel);
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:quota-failed',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
    });

    const playback = await controller.start(stream);
    await expect(playback.completion).rejects.toBeInstanceOf(MseBufferQuotaExceededError);
    expect(sourceBuffer.appendAttempts).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mediaElement.src).toBe('');
  });

  it('快速切换时丢弃旧流迟到的媒体块并只追加新流', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const cancelA = vi.fn(async () => undefined);
    const acknowledgeA = vi.fn();
    let releaseA: ((chunk: MediaWorkerStreamChunk) => void) | undefined;
    const streamA: MediaWorkerStream = {
      mimeType: 'video/mp4',
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
      completion: Promise.resolve(),
      read: () =>
        new Promise<MediaWorkerStreamChunk>((resolve) => {
          releaseA = resolve;
        }),
      cancel: cancelA,
    };
    const acknowledgeB = vi.fn();
    const streamB = createStream([{ bytes: new Uint8Array([2]), acknowledge: acknowledgeB }]);
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:switch',
      revokeObjectURL: vi.fn(),
      isTypeSupported: () => true,
      maxBufferedAheadSeconds: 120,
    });

    await controller.start(streamA);
    await flush();
    const switching = controller.start(streamB);
    expect(cancelA).toHaveBeenCalledOnce();

    releaseA?.({ bytes: new Uint8Array([1]), acknowledge: acknowledgeA });
    const playbackB = await switching;
    await flush();

    expect(sourceBuffer.appends).toEqual([new Uint8Array([2])]);
    sourceBuffer.finish();
    await playbackB.completion;
    await controller.stop();
    expect(acknowledgeA).not.toHaveBeenCalled();
    expect(acknowledgeB).toHaveBeenCalledOnce();
  });

  it('停止会取消 Worker 流并释放播放器 URL', async () => {
    const sourceBuffer = new TestSourceBuffer();
    const mediaSource = new TestMediaSource(sourceBuffer);
    const mediaElement = new TestMediaElement();
    const cancel = vi.fn(async () => undefined);
    const revoke = vi.fn();
    const stream = createStream([{ bytes: new Uint8Array([1]), acknowledge: vi.fn() }], cancel);
    const controller = new MsePlaybackController({
      mediaElement: mediaElement as unknown as HTMLMediaElement,
      createMediaSource: () => mediaSource as unknown as MediaSource,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: revoke,
      isTypeSupported: () => true,
    });

    const playback = await controller.start(stream);
    await flush();
    await playback.stop();

    expect(cancel).toHaveBeenCalledOnce();
    expect(mediaElement.pause).toHaveBeenCalledOnce();
    expect(mediaElement.src).toBe('');
    expect(mediaElement.load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:test');
    await expect(playback.completion).resolves.toBeUndefined();
  });

  it('浏览器不支持输出 MIME 时在创建 MSE 前取消流', async () => {
    const cancel = vi.fn(async () => undefined);
    const stream = createStream([], cancel);
    const controller = new MsePlaybackController({
      mediaElement: new TestMediaElement() as unknown as HTMLMediaElement,
      createMediaSource: () => {
        throw new Error('must not create');
      },
      isTypeSupported: () => false,
    });

    await expect(controller.start(stream)).rejects.toBeInstanceOf(MseTypeUnsupportedError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const createStream = (
  chunks: Array<{ bytes: Uint8Array; acknowledge: () => void }>,
  cancel = vi.fn(async () => undefined),
  timeline: {
    durationSeconds?: number;
    timelineOffsetSeconds?: number;
    initialPositionSeconds?: number;
  } = {},
): MediaWorkerStream => {
  let index = 0;
  return {
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    ...(timeline.durationSeconds !== undefined
      ? { durationSeconds: timeline.durationSeconds }
      : {}),
    timelineOffsetSeconds: timeline.timelineOffsetSeconds ?? 0,
    initialPositionSeconds: timeline.initialPositionSeconds ?? 0,
    completion: Promise.resolve(),
    read: async (): Promise<MediaWorkerStreamChunk | undefined> => {
      const chunk = chunks[index++];
      if (!chunk) return undefined;
      return {
        bytes: Uint8Array.from(chunk.bytes),
        acknowledge: chunk.acknowledge,
      };
    },
    cancel,
  };
};

const ranges = (values: Array<[number, number]>): TimeRanges => ({
  length: values.length,
  start: (index) => {
    const value = values[index];
    if (!value) throw new DOMException('IndexSizeError');
    return value[0];
  },
  end: (index) => {
    const value = values[index];
    if (!value) throw new DOMException('IndexSizeError');
    return value[1];
  },
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

type ReadyState = MediaSource['readyState'];
