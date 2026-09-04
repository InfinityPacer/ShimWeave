import type { ByteRange, ByteSource } from '@shimweave/contracts';
import {
  RangeScheduler,
  type RangeTaskScheduler,
  type ScheduledRangeTask,
} from './range-scheduler.js';

export const RANGE_PRIORITY = {
  seek: 0,
  playback: 10,
  index: 20,
  prefetch: 30,
} as const;

export interface RangeReadOptions {
  /** 取消仅移除当前订阅者；仍有订阅者共享时不会中止上游。 */
  signal?: AbortSignal;
  /** 数值越小优先级越高；高优先级可淘汰尚未执行的低优先级任务。 */
  priority?: number;
}

export interface RangeBrokerOptions {
  /** 多个 Broker 共享同一实例时，远程读取受统一的跨媒体并发约束。 */
  scheduler?: RangeTaskScheduler;
  /** LRU 缓存的字节上限，设为 0 时关闭缓存。 */
  maxCacheBytes?: number;
  /** LRU 缓存的条目上限，避免大量微小 Range 消耗过多堆对象。 */
  maxCacheEntries?: number;
  /** 首个连续读取窗口；后续顺序 miss 会指数增长，兼顾首帧与长片请求密度。 */
  initialReadAheadBytes?: number;
  /** 顺序读取窗口上限；设为 0 时关闭 read-ahead。 */
  maxReadAheadBytes?: number;
}

/** RangeBrokerStats 是不含源 URL 和媒体身份的单源运行时计数快照。 */
export interface RangeBrokerStats {
  active: number;
  queued: number;
  cacheEntries: number;
  cacheBytes: number;
  cacheHits: number;
  cacheMisses: number;
  sharedReads: number;
  evictions: number;
  upstreamReads: number;
  upstreamBytes: number;
}

interface Subscriber {
  range: ByteRange;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface RangeTask {
  range: ByteRange;
  priority: number;
  subscribers: Set<Subscriber>;
  scheduled?: ScheduledRangeTask<Uint8Array>;
  execution?: Promise<void>;
}

interface CacheEntry {
  range: ByteRange;
  bytes: Uint8Array;
}

interface SizeSubscriber {
  resolve: (size: number) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface SizeTask {
  controller: AbortController;
  subscribers: Set<SizeSubscriber>;
  scheduled?: ScheduledRangeTask<number>;
  execution?: Promise<void>;
}

const DEFAULT_MAX_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_INITIAL_READ_AHEAD_BYTES = 512 * 1024;
const DEFAULT_MAX_READ_AHEAD_BYTES = 4 * 1024 * 1024;

/** RangeBroker 为单一媒体源提供覆盖读取共享和短期 LRU，并将 I/O 交给全局调度器。 */
export class RangeBroker implements ByteSource {
  readonly sourceId: string;

  private readonly scheduler: RangeTaskScheduler;
  private readonly ownedScheduler: RangeScheduler | undefined;
  private readonly maxCacheBytes: number;
  private readonly maxCacheEntries: number;
  private readonly initialReadAheadBytes: number;
  private readonly maxReadAheadBytes: number;
  private readonly tasks = new Set<RangeTask>();
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private sharedReads = 0;
  private evictions = 0;
  private upstreamReads = 0;
  private upstreamBytes = 0;
  private nextReadAheadBytes: number;
  private lastReadAheadRange: ByteRange | undefined;
  private fixedReadAheadBytes: number | undefined;
  private knownSize: number | undefined;
  private sizeTask: SizeTask | undefined;
  private closed = false;

  constructor(
    private readonly source: ByteSource,
    options: RangeBrokerOptions = {},
  ) {
    this.sourceId = source.sourceId;
    if (options.scheduler) {
      this.scheduler = options.scheduler;
      this.ownedScheduler = undefined;
    } else {
      const scheduler = new RangeScheduler();
      this.scheduler = scheduler;
      this.ownedScheduler = scheduler;
    }
    this.maxCacheBytes = nonNegativeInteger(
      options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
      'maxCacheBytes',
    );
    this.maxCacheEntries = nonNegativeInteger(
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      'maxCacheEntries',
    );
    this.initialReadAheadBytes = nonNegativeInteger(
      options.initialReadAheadBytes ?? DEFAULT_INITIAL_READ_AHEAD_BYTES,
      'initialReadAheadBytes',
    );
    this.maxReadAheadBytes = nonNegativeInteger(
      options.maxReadAheadBytes ?? DEFAULT_MAX_READ_AHEAD_BYTES,
      'maxReadAheadBytes',
    );
    if (this.maxReadAheadBytes > 0 && this.initialReadAheadBytes > this.maxReadAheadBytes) {
      throw new RangeError('initialReadAheadBytes must not exceed maxReadAheadBytes');
    }
    this.nextReadAheadBytes = this.initialReadAheadBytes;
  }

  getSize(signal?: AbortSignal): Promise<number> {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.knownSize !== undefined) return Promise.resolve(this.knownSize);
    if (this.sizeTask) return this.subscribeSize(this.sizeTask, signal);

    const task: SizeTask = {
      controller: new AbortController(),
      subscribers: new Set<SizeSubscriber>(),
    };
    this.sizeTask = task;
    const result = this.subscribeSize(task, signal);
    try {
      task.scheduled = this.scheduler.schedule(
        {
          sourceId: this.sourceId,
          priority: RANGE_PRIORITY.index,
          signal: task.controller.signal,
        },
        (schedulerSignal) => this.source.getSize(schedulerSignal),
      );
      task.execution = this.executeSizeTask(task);
    } catch (error) {
      this.rejectSizeTask(task, error);
    }
    return result;
  }

  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    return this.readWithPriority(range, {
      ...(signal ? { signal } : {}),
      priority: RANGE_PRIORITY.playback,
    });
  }

  /** 固定窗口适合音视频轨交错的连续转换；传入 undefined 可恢复自适应探测窗口。 */
  setReadAheadBytes(bytes: number | undefined): void {
    if (bytes !== undefined) nonNegativeInteger(bytes, 'readAheadBytes');
    this.fixedReadAheadBytes = bytes;
    this.lastReadAheadRange = undefined;
    this.nextReadAheadBytes = this.initialReadAheadBytes;
  }

  readWithPriority(range: ByteRange, options: RangeReadOptions = {}): Promise<Uint8Array> {
    this.assertOpen();
    validateRange(range);
    if (this.knownSize !== undefined && range.end > this.knownSize) {
      throw new RangeError('Byte range exceeds the known source size');
    }
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));

    const priority = finiteNumber(options.priority ?? RANGE_PRIORITY.playback, 'priority');
    if (
      this.fixedReadAheadBytes !== undefined &&
      this.fixedReadAheadBytes > 0 &&
      this.knownSize !== undefined &&
      this.maxCacheBytes > 0 &&
      this.maxCacheEntries > 0
    ) {
      return this.readFixedBlocks(range, priority, options.signal);
    }
    return this.readSingle(range, priority, options.signal, true);
  }

  private readSingle(
    range: ByteRange,
    priority: number,
    signal: AbortSignal | undefined,
    expand: boolean,
  ): Promise<Uint8Array> {
    const cached = this.findCached(range);
    if (cached) {
      this.cacheHits += 1;
      return Promise.resolve(sliceRange(cached.range, cached.bytes, range));
    }
    this.cacheMisses += 1;

    const existing = this.findCoveringTask(range);
    if (existing) {
      this.sharedReads += 1;
      existing.priority = Math.min(existing.priority, priority);
      existing.scheduled?.promote(priority);
      return this.subscribe(existing, range, signal);
    }

    const task: RangeTask = {
      range: expand ? this.expandRange(range) : { ...range },
      priority,
      subscribers: new Set<Subscriber>(),
    };
    this.tasks.add(task);
    const result = this.subscribe(task, range, signal);
    try {
      task.scheduled = this.scheduler.schedule(
        { sourceId: this.sourceId, priority },
        (schedulerSignal) => this.source.read(task.range, schedulerSignal),
      );
      task.execution = this.executeTask(task);
    } catch (error) {
      this.rejectTask(task, error);
    }
    return result;
  }

  private async readFixedBlocks(
    range: ByteRange,
    priority: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const knownSize = this.knownSize;
    const fixedWindow = this.fixedReadAheadBytes;
    if (knownSize === undefined || fixedWindow === undefined || fixedWindow === 0) {
      return this.readSingle(range, priority, signal, false);
    }
    const window = Math.min(fixedWindow, this.maxCacheBytes);
    const blocks: ByteRange[] = [];
    for (
      let start = Math.floor(range.start / window) * window;
      start < range.end;
      start += window
    ) {
      blocks.push({ start, end: Math.min(knownSize, start + window) });
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    signal?.addEventListener('abort', relayAbort, { once: true });
    const reads = blocks.map((block) => this.readSingle(block, priority, controller.signal, false));
    try {
      const chunks = await Promise.all(reads);
      const firstBlock = blocks[0];
      const firstChunk = chunks[0];
      if (chunks.length === 1 && firstBlock && firstChunk) {
        return sliceRange(firstBlock, firstChunk, range);
      }
      const result = new Uint8Array(rangeLength(range));
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const chunk = chunks[index];
        if (!block || !chunk) continue;
        const overlapStart = Math.max(block.start, range.start);
        const overlapEnd = Math.min(block.end, range.end);
        result.set(
          chunk.subarray(overlapStart - block.start, overlapEnd - block.start),
          overlapStart - range.start,
        );
      }
      return result;
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(reads);
      throw error;
    } finally {
      signal?.removeEventListener('abort', relayAbort);
    }
  }

  stats(): RangeBrokerStats {
    let active = 0;
    let queued = 0;
    for (const task of this.tasks) {
      if (task.scheduled?.state === 'running') active += 1;
      if (task.scheduled?.state === 'queued') queued += 1;
    }
    return {
      active,
      queued,
      cacheEntries: this.cache.size,
      cacheBytes: this.cacheBytes,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      sharedReads: this.sharedReads,
      evictions: this.evictions,
      upstreamReads: this.upstreamReads,
      upstreamBytes: this.upstreamBytes,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new RangeBrokerClosedError();
    const sizeExecution = this.sizeTask?.execution;
    if (this.sizeTask) {
      this.sizeTask.controller.abort(error);
      this.rejectSizeTask(this.sizeTask, error);
    }

    const executions: Promise<void>[] = [];
    for (const task of this.tasks) {
      if (task.execution) executions.push(task.execution);
      task.scheduled?.cancel(error);
      this.rejectTask(task, error);
    }
    this.tasks.clear();
    this.cache.clear();
    this.cacheBytes = 0;

    const sourceClose = Promise.resolve().then(() => this.source.close());
    const schedulerClose = this.ownedScheduler?.close() ?? Promise.resolve();
    const results = await Promise.allSettled([
      sourceClose,
      schedulerClose,
      ...executions,
      ...(sizeExecution ? [sizeExecution] : []),
    ]);
    const sourceResult = results[0];
    if (sourceResult?.status === 'rejected') throw sourceResult.reason;
  }

  private subscribeSize(task: SizeTask, signal: AbortSignal | undefined): Promise<number> {
    return new Promise((resolve, reject) => {
      const subscriber: SizeSubscriber = { resolve, reject };
      task.subscribers.add(subscriber);
      if (!signal) return;
      subscriber.signal = signal;
      subscriber.abort = () => {
        if (!task.subscribers.delete(subscriber)) return;
        this.detachSizeSubscriber(subscriber);
        reject(abortReason(signal));
        if (task.subscribers.size === 0) {
          task.controller.abort(abortReason(signal));
          if (this.sizeTask === task) this.sizeTask = undefined;
        }
      };
      signal.addEventListener('abort', subscriber.abort, { once: true });
      if (signal.aborted) subscriber.abort();
    });
  }

  private async executeSizeTask(task: SizeTask): Promise<void> {
    try {
      const size = await task.scheduled?.promise;
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw new RangeError('Byte source size must be a non-negative safe integer');
      }
      if (task.controller.signal.aborted || task.subscribers.size === 0) {
        throw abortReason(task.controller.signal);
      }
      this.knownSize = size;
      for (const subscriber of task.subscribers) {
        this.detachSizeSubscriber(subscriber);
        subscriber.resolve(size);
      }
    } catch (error) {
      for (const subscriber of task.subscribers) {
        this.detachSizeSubscriber(subscriber);
        subscriber.reject(error);
      }
    } finally {
      task.subscribers.clear();
      if (this.sizeTask === task) this.sizeTask = undefined;
    }
  }

  private subscribe(
    task: RangeTask,
    range: ByteRange,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const subscriber: Subscriber = { range: { ...range }, resolve, reject };
      task.subscribers.add(subscriber);
      if (!signal) return;
      subscriber.signal = signal;
      subscriber.abort = () => {
        if (!task.subscribers.delete(subscriber)) return;
        this.detachSubscriber(subscriber);
        reject(abortReason(signal));
        if (task.subscribers.size === 0) {
          task.scheduled?.cancel(abortReason(signal));
          this.tasks.delete(task);
        }
      };
      signal.addEventListener('abort', subscriber.abort, { once: true });
      if (signal.aborted) subscriber.abort();
    });
  }

  private async executeTask(task: RangeTask): Promise<void> {
    try {
      const bytes = await task.scheduled?.promise;
      if (!bytes || task.subscribers.size === 0) return;
      const expected = task.range.end - task.range.start;
      if (bytes.byteLength !== expected) {
        throw new RangeLengthError(expected, bytes.byteLength);
      }
      this.upstreamReads += 1;
      this.upstreamBytes += bytes.byteLength;
      this.remember(task.range, bytes);
      for (const subscriber of task.subscribers) {
        this.detachSubscriber(subscriber);
        subscriber.resolve(sliceRange(task.range, bytes, subscriber.range));
      }
    } catch (error) {
      for (const subscriber of task.subscribers) {
        this.detachSubscriber(subscriber);
        subscriber.reject(error);
      }
    } finally {
      task.subscribers.clear();
      this.tasks.delete(task);
    }
  }

  private rejectTask(task: RangeTask, error: unknown): void {
    for (const subscriber of task.subscribers) {
      this.detachSubscriber(subscriber);
      subscriber.reject(error);
    }
    task.subscribers.clear();
    this.tasks.delete(task);
  }

  private rejectSizeTask(task: SizeTask, error: unknown): void {
    for (const subscriber of task.subscribers) {
      this.detachSizeSubscriber(subscriber);
      subscriber.reject(error);
    }
    task.subscribers.clear();
    if (this.sizeTask === task) this.sizeTask = undefined;
  }

  private findCoveringTask(range: ByteRange): RangeTask | undefined {
    let candidate: RangeTask | undefined;
    for (const task of this.tasks) {
      if (!covers(task.range, range) || task.subscribers.size === 0) continue;
      if (!candidate || rangeLength(task.range) < rangeLength(candidate.range)) candidate = task;
    }
    return candidate;
  }

  private expandRange(range: ByteRange): ByteRange {
    if (this.fixedReadAheadBytes !== undefined) return { ...range };
    if (
      this.knownSize === undefined ||
      this.maxCacheBytes === 0 ||
      this.initialReadAheadBytes === 0 ||
      this.maxReadAheadBytes === 0
    ) {
      this.lastReadAheadRange = undefined;
      this.nextReadAheadBytes = this.initialReadAheadBytes;
      return { ...range };
    }

    const sequential =
      this.lastReadAheadRange !== undefined &&
      range.start >= this.lastReadAheadRange.end &&
      range.start - this.lastReadAheadRange.end <= this.initialReadAheadBytes;
    const configuredWindow = sequential
      ? Math.min(this.nextReadAheadBytes, this.maxReadAheadBytes)
      : this.initialReadAheadBytes;
    const window = Math.min(configuredWindow, this.maxCacheBytes);
    const requestedLength = rangeLength(range);
    let start = range.start;
    if (!sequential && requestedLength < window) {
      start = Math.floor(range.start / window) * window;
    }
    const end = Math.min(this.knownSize, Math.max(range.end, start + window));
    const expanded = { start, end };
    this.lastReadAheadRange = expanded;
    this.nextReadAheadBytes = sequential
      ? Math.min(window * 2, this.maxReadAheadBytes, this.maxCacheBytes)
      : Math.min(this.initialReadAheadBytes * 2, this.maxReadAheadBytes, this.maxCacheBytes);
    return expanded;
  }

  private findCached(range: ByteRange): CacheEntry | undefined {
    let candidateKey: string | undefined;
    let candidate: CacheEntry | undefined;
    for (const [key, entry] of this.cache) {
      if (!covers(entry.range, range)) continue;
      if (!candidate || rangeLength(entry.range) < rangeLength(candidate.range)) {
        candidateKey = key;
        candidate = entry;
      }
    }
    if (!candidate || !candidateKey) return undefined;
    this.cache.delete(candidateKey);
    this.cache.set(candidateKey, candidate);
    return candidate;
  }

  private remember(range: ByteRange, bytes: Uint8Array): void {
    if (
      this.maxCacheBytes === 0 ||
      this.maxCacheEntries === 0 ||
      bytes.byteLength > this.maxCacheBytes
    ) {
      return;
    }
    const key = rangeKey(range);
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes.byteLength;
    this.cache.delete(key);
    const cachedBytes = compactView(bytes);
    this.cache.set(key, { range: { ...range }, bytes: cachedBytes });
    this.cacheBytes += cachedBytes.byteLength;

    while (this.cacheBytes > this.maxCacheBytes || this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bytes.byteLength;
      this.evictions += 1;
    }
  }

  private detachSubscriber(subscriber: Subscriber): void {
    if (subscriber.signal && subscriber.abort) {
      subscriber.signal.removeEventListener('abort', subscriber.abort);
    }
  }

  private detachSizeSubscriber(subscriber: SizeSubscriber): void {
    if (subscriber.signal && subscriber.abort) {
      subscriber.signal.removeEventListener('abort', subscriber.abort);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RangeBrokerClosedError();
  }
}

/** RangeLengthError 表示 ByteSource 违反准确区间长度契约。 */
export class RangeLengthError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Range source returned ${actual} bytes; expected ${expected}`);
    this.name = 'RangeLengthError';
  }
}

/** RangeBrokerClosedError 表示媒体源会话已经结束。 */
export class RangeBrokerClosedError extends Error {
  constructor() {
    super('Range broker is closed');
    this.name = 'RangeBrokerClosedError';
  }
}

const validateRange = (range: ByteRange): void => {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  ) {
    throw new RangeError('Byte range must be a non-empty safe integer interval');
  }
};

const covers = (outer: ByteRange, inner: ByteRange): boolean =>
  outer.start <= inner.start && outer.end >= inner.end;

const rangeLength = (range: ByteRange): number => range.end - range.start;
const rangeKey = (range: ByteRange): string => `${range.start}:${range.end}`;

const sliceRange = (outer: ByteRange, bytes: Uint8Array, inner: ByteRange): Uint8Array =>
  bytes.subarray(inner.start - outer.start, inner.end - outer.start);

const compactView = (bytes: Uint8Array): Uint8Array =>
  bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength
    ? bytes
    : Uint8Array.from(bytes);

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  return value;
};

const finiteNumber = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
};
