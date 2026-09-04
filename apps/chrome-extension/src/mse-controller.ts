import type { MediaWorkerStream } from './media-worker-client.js';

export interface MsePlaybackControllerOptions {
  mediaElement: HTMLMediaElement;
  maxBufferedAheadSeconds?: number;
  maxBufferedBehindSeconds?: number;
  /** SourceBuffer 内压缩媒体的近似字节上限，允许单个写入块的有界超出。 */
  maxBufferedBytes?: number;
  capacityPollMs?: number;
  createMediaSource?: () => MediaSource;
  createObjectURL?: (source: MediaSource) => string;
  revokeObjectURL?: (url: string) => void;
  isTypeSupported?: (mimeType: string) => boolean;
  onAutoplayError?: (error: unknown) => void;
}

export interface MsePlaybackSession {
  readonly completion: Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_MAX_BUFFERED_AHEAD_SECONDS = 90;
const DEFAULT_MAX_BUFFERED_BEHIND_SECONDS = 30;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const DEFAULT_CAPACITY_POLL_MS = 100;
const MINIMUM_DECODER_HISTORY_SECONDS = 30;
const MEDIA_HAVE_METADATA = 1;

/**
 * MsePlaybackController 是 Player Frame 的媒体消费边界。每个 Worker chunk 只有在
 * SourceBuffer 完成 append 后才 ACK，并通过有限时间窗口约束长片内存占用。
 */
export class MsePlaybackController {
  private readonly options: Required<
    Pick<
      MsePlaybackControllerOptions,
      | 'capacityPollMs'
      | 'createMediaSource'
      | 'createObjectURL'
      | 'isTypeSupported'
      | 'maxBufferedAheadSeconds'
      | 'maxBufferedBehindSeconds'
      | 'maxBufferedBytes'
      | 'onAutoplayError'
      | 'revokeObjectURL'
    >
  > &
    Pick<MsePlaybackControllerOptions, 'mediaElement'>;
  private active: ActiveMsePlayback | undefined;

  constructor(options: MsePlaybackControllerOptions) {
    this.options = {
      mediaElement: options.mediaElement,
      maxBufferedAheadSeconds:
        options.maxBufferedAheadSeconds ?? DEFAULT_MAX_BUFFERED_AHEAD_SECONDS,
      maxBufferedBehindSeconds:
        options.maxBufferedBehindSeconds ?? DEFAULT_MAX_BUFFERED_BEHIND_SECONDS,
      maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      capacityPollMs: options.capacityPollMs ?? DEFAULT_CAPACITY_POLL_MS,
      createMediaSource: options.createMediaSource ?? (() => new MediaSource()),
      createObjectURL: options.createObjectURL ?? ((source) => URL.createObjectURL(source)),
      revokeObjectURL: options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url)),
      isTypeSupported:
        options.isTypeSupported ?? ((mimeType) => MediaSource.isTypeSupported(mimeType)),
      onAutoplayError: options.onAutoplayError ?? (() => undefined),
    };
    assertPositiveWindow(this.options.maxBufferedAheadSeconds, 'maxBufferedAheadSeconds');
    assertNonNegativeWindow(this.options.maxBufferedBehindSeconds, 'maxBufferedBehindSeconds');
    if (
      !Number.isSafeInteger(this.options.maxBufferedBytes) ||
      this.options.maxBufferedBytes <= 0
    ) {
      throw new RangeError('maxBufferedBytes must be a positive safe integer');
    }
    if (!Number.isFinite(this.options.capacityPollMs) || this.options.capacityPollMs <= 0) {
      throw new RangeError('capacityPollMs must be greater than zero');
    }
  }

  async start(stream: MediaWorkerStream): Promise<MsePlaybackSession> {
    await this.stop();
    if (!this.options.isTypeSupported(stream.mimeType)) {
      await stream.cancel();
      throw new MseTypeUnsupportedError(stream.mimeType);
    }

    const active = new ActiveMsePlayback(stream, this.options);
    this.active = active;
    try {
      await active.open();
    } catch (error) {
      if (this.active === active) this.active = undefined;
      await active.stop();
      throw error;
    }
    active.start();
    return {
      completion: active.completion,
      stop: () => this.stopActive(active),
    };
  }

  stop(): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    return this.stopActive(active);
  }

  private async stopActive(active: ActiveMsePlayback): Promise<void> {
    if (this.active === active) this.active = undefined;
    await active.stop();
  }
}

class ActiveMsePlayback {
  readonly completion: Promise<void>;

  private readonly abortController = new AbortController();
  private readonly mediaSource: MediaSource;
  private readonly objectURL: string;
  private sourceBuffer: SourceBuffer | undefined;
  private resolveCompletion: () => void = () => undefined;
  private rejectCompletion: (error: unknown) => void = () => undefined;
  private runPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private playbackRequested = false;
  private initialPositionApplied = false;
  private initialPositionBuffered = false;
  private readonly bufferedBytes = new BufferedByteLedger();

  constructor(
    private readonly stream: MediaWorkerStream,
    private readonly options: MsePlaybackController['options'],
  ) {
    this.mediaSource = options.createMediaSource();
    this.objectURL = options.createObjectURL(this.mediaSource);
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => undefined);
  }

  async open(): Promise<void> {
    this.options.mediaElement.src = this.objectURL;
    if (this.mediaSource.readyState !== 'open') {
      await waitForEvent(this.mediaSource, 'sourceopen', this.abortController.signal);
    }
    const durationSeconds = this.stream.durationSeconds;
    if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      // MediaSource 只有在 open 状态允许设置 duration；完整时长独立于当前缓冲区窗口。
      this.mediaSource.duration = durationSeconds;
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.stream.mimeType);
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.timestampOffset = this.stream.timelineOffsetSeconds;
  }

  start(): void {
    if (this.runPromise) return;
    this.runPromise = this.run();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async run(): Promise<void> {
    try {
      const sourceBuffer = this.sourceBuffer;
      if (!sourceBuffer) throw new MsePlaybackStateError();
      while (!this.abortController.signal.aborted) {
        await this.waitForCapacity(sourceBuffer);
        const chunk = await this.stream.read();
        if (!chunk) break;
        const previousEnd = lastBufferedEnd(sourceBuffer.buffered);
        await this.appendChunk(sourceBuffer, chunk.bytes);
        this.bufferedBytes.append(chunk.bytes.byteLength, previousEnd, sourceBuffer.buffered);
        if (
          !this.initialPositionBuffered &&
          bufferedAt(sourceBuffer.buffered, this.initialPositionSeconds)
        ) {
          this.initialPositionBuffered = true;
          this.applyInitialPositionIfReady();
          this.requestPlayback();
        }
        if (this.initialPositionBuffered) await this.evictOldBuffer(sourceBuffer);
        chunk.acknowledge();
      }
      await this.stream.completion;
      if (!this.initialPositionBuffered) {
        throw new MseSeekTargetUnavailableError(this.initialPositionSeconds);
      }
      if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      this.resolveCompletion();
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.resolveCompletion();
        return;
      }
      await this.stream.cancel().catch(() => undefined);
      this.detachMedia();
      this.rejectCompletion(error);
    }
  }

  private async stopInternal(): Promise<void> {
    this.abortController.abort(new MsePlaybackStoppedError());
    await this.stream.cancel().catch(() => undefined);
    await this.runPromise?.catch(() => undefined);
    this.detachMedia();
    this.resolveCompletion();
  }

  private async waitForCapacity(sourceBuffer: SourceBuffer): Promise<void> {
    while (this.capacityExceeded(sourceBuffer)) {
      const bytePressure = this.byteBudgetExceeded();
      if (
        this.initialPositionBuffered &&
        (await this.evictOldBuffer(sourceBuffer, bytePressure)) &&
        !this.capacityExceeded(sourceBuffer)
      ) {
        return;
      }
      if (
        bytePressure &&
        !this.timeBudgetExceeded(sourceBuffer) &&
        !this.bufferedBytes.hasForwardFragmentAfter(this.options.mediaElement.currentTime)
      ) {
        return;
      }
      await waitForEventOrTimeout(
        this.options.mediaElement,
        'timeupdate',
        this.options.capacityPollMs,
        this.abortController.signal,
      );
    }
  }

  private capacityExceeded(sourceBuffer: SourceBuffer): boolean {
    return this.timeBudgetExceeded(sourceBuffer) || this.byteBudgetExceeded();
  }

  private timeBudgetExceeded(sourceBuffer: SourceBuffer): boolean {
    return (
      bufferedAhead(sourceBuffer.buffered, this.options.mediaElement.currentTime) >=
      this.options.maxBufferedAheadSeconds
    );
  }

  private byteBudgetExceeded(): boolean {
    return (
      this.initialPositionBuffered && this.bufferedBytes.byteLength >= this.options.maxBufferedBytes
    );
  }

  private async appendChunk(
    sourceBuffer: SourceBuffer,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const append = () =>
      runSourceBufferOperation(
        sourceBuffer,
        () => sourceBuffer.appendBuffer(bytes),
        this.abortController.signal,
      );
    try {
      await append();
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;
      if (!(await this.evictOldBuffer(sourceBuffer))) {
        throw new MseBufferQuotaExceededError();
      }
      try {
        await append();
      } catch (retryError) {
        if (isQuotaExceededError(retryError)) throw new MseBufferQuotaExceededError();
        throw retryError;
      }
    }
  }

  private async evictOldBuffer(
    sourceBuffer: SourceBuffer,
    underBytePressure = false,
  ): Promise<boolean> {
    if (!this.initialPositionApplied || sourceBuffer.buffered.length === 0) return false;
    const normalRemoveBefore =
      this.options.mediaElement.currentTime -
      Math.max(this.options.maxBufferedBehindSeconds, MINIMUM_DECODER_HISTORY_SECONDS);
    const fragmentBoundary = underBytePressure
      ? this.bufferedBytes.latestBoundaryBefore(this.options.mediaElement.currentTime)
      : undefined;
    const removeBefore = underBytePressure
      ? (fragmentBoundary ?? Number.NEGATIVE_INFINITY)
      : normalRemoveBefore;
    const firstStart = sourceBuffer.buffered.start(0);
    const removeEnd = removeBefore;
    if (removeEnd <= firstStart) return false;
    await runSourceBufferOperation(
      sourceBuffer,
      () => sourceBuffer.remove(firstStart, removeEnd),
      this.abortController.signal,
    );
    this.bufferedBytes.removeBefore(removeEnd);
    return true;
  }

  private requestPlayback(): void {
    if (this.playbackRequested) return;
    this.playbackRequested = true;
    void this.startPlayback();
  }

  private async startPlayback(): Promise<void> {
    try {
      await this.applyInitialPosition();
      await this.options.mediaElement.play();
    } catch (error) {
      if (!this.abortController.signal.aborted) this.options.onAutoplayError(error);
    }
  }

  private async applyInitialPosition(): Promise<void> {
    if (this.initialPositionApplied) return;
    if (this.options.mediaElement.readyState < MEDIA_HAVE_METADATA) {
      await waitForEvent(this.options.mediaElement, 'loadedmetadata', this.abortController.signal);
    }
    this.options.mediaElement.currentTime = this.initialPositionSeconds;
    this.initialPositionApplied = true;
  }

  private applyInitialPositionIfReady(): void {
    if (this.initialPositionApplied || this.options.mediaElement.readyState < MEDIA_HAVE_METADATA) {
      return;
    }
    this.options.mediaElement.currentTime = this.initialPositionSeconds;
    this.initialPositionApplied = true;
  }

  /** MSE 内部片段以零开始，播放器和站点始终使用原媒体的绝对时间。 */
  private get initialPositionSeconds(): number {
    return this.stream.timelineOffsetSeconds + this.stream.initialPositionSeconds;
  }

  private detachMedia(): void {
    if (this.options.mediaElement.src !== this.objectURL) return;
    this.options.mediaElement.pause();
    this.options.mediaElement.removeAttribute('src');
    this.options.mediaElement.load();
    this.options.revokeObjectURL(this.objectURL);
  }
}

interface BufferedByteEntry {
  start: number;
  end: number;
  bytes: number;
}

/**
 * SourceBuffer 不暴露字节用量。该账本把完成一次缓冲区扩展前的连续写入
 * 归到同一媒体时间段，清理部分区间时按时长比例保守扣减。
 */
class BufferedByteLedger {
  private readonly entries: BufferedByteEntry[] = [];
  private pendingBytes = 0;
  private trackedBytes = 0;

  get byteLength(): number {
    return this.trackedBytes + this.pendingBytes;
  }

  append(bytes: number, previousEnd: number | undefined, ranges: TimeRanges): void {
    this.pendingBytes += bytes;
    const nextEnd = lastBufferedEnd(ranges);
    if (nextEnd === undefined || (previousEnd !== undefined && nextEnd <= previousEnd + 0.001)) {
      return;
    }
    const start = previousEnd ?? firstBufferedStart(ranges) ?? nextEnd;
    if (nextEnd <= start) return;
    this.entries.push({ start, end: nextEnd, bytes: this.pendingBytes });
    this.trackedBytes += this.pendingBytes;
    this.pendingBytes = 0;
  }

  /** 字节压力下至少保留当前分片及其后的一个完整分片，避免背压先于播放进度形成死锁。 */
  hasForwardFragmentAfter(position: number): boolean {
    let foundCurrent = false;
    for (const entry of this.entries) {
      if (!foundCurrent) {
        foundCurrent = entry.end >= position - 0.05;
        continue;
      }
      if (entry.end > position + 0.05) return true;
    }
    return false;
  }

  /** 每个已完成的 fMP4 分片都从可随机访问点开始，只淘汰完全位于播放点之前的旧边界。 */
  latestBoundaryBefore(position: number): number | undefined {
    let boundary: number | undefined;
    for (const entry of this.entries) {
      if (entry.end >= position - 0.05) break;
      boundary = entry.end;
    }
    return boundary;
  }

  removeBefore(position: number): void {
    while (this.entries.length > 0) {
      const entry = this.entries[0];
      if (!entry) return;
      if (entry.end <= position) {
        this.entries.shift();
        this.trackedBytes -= entry.bytes;
        continue;
      }
      if (entry.start < position) {
        const remainingRatio = (entry.end - position) / (entry.end - entry.start);
        const remainingBytes = Math.ceil(entry.bytes * remainingRatio);
        this.trackedBytes -= entry.bytes - remainingBytes;
        entry.start = position;
        entry.bytes = remainingBytes;
      }
      return;
    }
  }
}

export class MseTypeUnsupportedError extends Error {
  constructor(readonly mimeType: string) {
    super(`MediaSource does not support ${mimeType}`);
    this.name = 'MseTypeUnsupportedError';
  }
}

export class MsePlaybackStateError extends Error {
  constructor() {
    super('MSE playback is not open');
    this.name = 'MsePlaybackStateError';
  }
}

export class MsePlaybackStoppedError extends Error {
  constructor() {
    super('MSE playback was stopped');
    this.name = 'MsePlaybackStoppedError';
  }
}

export class MseSeekTargetUnavailableError extends Error {
  constructor(readonly targetSeconds: number) {
    super('MSE output did not contain the requested playback position');
    this.name = 'MseSeekTargetUnavailableError';
  }
}

export class MseBufferQuotaExceededError extends Error {
  constructor() {
    super('MSE buffer quota remained exhausted after old media was evicted');
    this.name = 'MseBufferQuotaExceededError';
  }
}

const runSourceBufferOperation = (
  sourceBuffer: SourceBuffer,
  operation: () => void,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new MsePlaybackStoppedError());
      return;
    }
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onError);
      sourceBuffer.removeEventListener('abort', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new MseSourceBufferError());
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new MsePlaybackStoppedError());
    };
    sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true });
    sourceBuffer.addEventListener('error', onError, { once: true });
    sourceBuffer.addEventListener('abort', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      operation();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

export class MseSourceBufferError extends Error {
  constructor() {
    super('SourceBuffer operation failed');
    this.name = 'MseSourceBufferError';
  }
}

const waitForEvent = (target: EventTarget, eventName: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new MsePlaybackStoppedError());
      return;
    }
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      signal.removeEventListener('abort', onAbort);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new MsePlaybackStoppedError());
    };
    target.addEventListener(eventName, onEvent, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });

const waitForEventOrTimeout = (
  target: EventTarget,
  eventName: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new MsePlaybackStoppedError());
      return;
    }
    const timer = setTimeout(() => finish(), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onEvent = () => finish();
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new MsePlaybackStoppedError());
    };
    target.addEventListener(eventName, onEvent, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });

const bufferedAhead = (ranges: TimeRanges, currentTime: number): number => {
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= currentTime + 0.25 && ranges.end(index) >= currentTime) {
      return ranges.end(index) - currentTime;
    }
  }
  return 0;
};

const bufferedAt = (ranges: TimeRanges, position: number): boolean => {
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= position + 0.05 && ranges.end(index) > position) return true;
  }
  return false;
};

const firstBufferedStart = (ranges: TimeRanges): number | undefined =>
  ranges.length > 0 ? ranges.start(0) : undefined;

const lastBufferedEnd = (ranges: TimeRanges): number | undefined =>
  ranges.length > 0 ? ranges.end(ranges.length - 1) : undefined;

const isQuotaExceededError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  error.name === 'QuotaExceededError';

const assertNonNegativeWindow = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must not be negative`);
};

const assertPositiveWindow = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
};
