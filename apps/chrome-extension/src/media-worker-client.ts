import type {
  AudioTranscodeOutput,
  MediaDescriptor,
  MediaSourceDescriptor,
} from '@shimweave/contracts';
import { createExtensionFrameWorker } from './extension-worker-bridge.js';
import {
  MEDIA_WORKER_PROTOCOL,
  type MediaWorkerHostMessage,
  type MediaWorkerInitMessage,
} from './media-worker-protocol.js';

interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

interface SharedWorkerLike {
  readonly port: MessagePort;
}

export interface MediaWorkerClientOptions {
  source: MediaSourceDescriptor;
  sessionId?: string;
  workerURL?: string;
  coordinatorURL?: string;
  createWorker?: (url: string, name: string) => WorkerLike;
  createSharedWorker?: (url: string, name: string) => SharedWorkerLike;
  readyTimeoutMs?: number;
}

export interface MediaWorkerStreamOptions {
  /** 设置后只按该确定配置转码音频，视频仍由媒体引擎保持原码流。 */
  outputAudio?: AudioTranscodeOutput;
  /** 轨道 ID 来自同一 Worker 返回的 MediaDescriptor。 */
  videoTrackId?: string;
  /** 轨道 ID 来自同一 Worker 返回的 MediaDescriptor。 */
  audioTrackId?: string;
  /** 非零值会从关键帧重建 fMP4/MSE 时间轴，不触发视频转码。 */
  startSeconds?: number;
}

export interface MediaWorkerStreamChunk {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** 只有媒体块被 SourceBuffer 消费后才能确认，以此向 Worker 施加真实背压。 */
  acknowledge(): void;
}

export interface MediaWorkerStream {
  readonly mimeType: string;
  /** 描述阶段得到的完整媒体时长，用于建立不受当前缓冲窗口限制的 MSE 时间轴。 */
  readonly durationSeconds?: number;
  readonly timelineOffsetSeconds: number;
  readonly initialPositionSeconds: number;
  readonly completion: Promise<void>;
  read(): Promise<MediaWorkerStreamChunk | undefined>;
  cancel(): Promise<void>;
}

interface StreamState {
  requestId: string;
  ready: Deferred<MediaWorkerStream>;
  completion: Deferred<void>;
  queuedChunk?: { chunkId: string; bytes: ArrayBuffer };
  readWaiter?: Deferred<MediaWorkerStreamChunk | undefined>;
  deliveredChunkId?: string;
  mimeType?: string;
  cancelled: boolean;
  ended: boolean;
}

/** MediaWorkerClient 让媒体块只跨 Worker/Player transferable 通道，不进入扩展运行时消息。 */
export class MediaWorkerClient {
  readonly sessionId: string;
  schedulerMode: 'shared' | 'local' | undefined;

  private readonly worker: WorkerLike;
  private readonly readyPromise: Promise<void>;
  private readonly pending = new Map<
    string,
    { resolve: (descriptor: MediaDescriptor) => void; reject: (error: unknown) => void }
  >();
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: unknown) => void = () => undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveClose: () => void = () => undefined;
  private terminalError: Error | undefined;
  private activeStream: StreamState | undefined;
  private sequence = 0;

  constructor(options: MediaWorkerClientOptions) {
    validateOptions(options);
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    const createWorker = options.createWorker ?? defaultWorkerFactory;
    this.worker = createWorker(
      options.workerURL ?? chrome.runtime.getURL('media-worker.js'),
      `shimweave-media-${this.sessionId}`,
    );
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.worker.onmessage = (event) => this.onMessage(event.data);
    this.worker.onerror = () => this.fail(new MediaWorkerConnectionError());
    this.readyTimer = setTimeout(
      () => this.fail(new MediaWorkerReadyTimeoutError()),
      options.readyTimeoutMs ?? 5_000,
    );

    const createSharedWorker = options.createSharedWorker ?? defaultSharedWorkerFactory;
    let sharedWorker: SharedWorkerLike | undefined;
    try {
      sharedWorker = createSharedWorker?.(
        options.coordinatorURL ?? chrome.runtime.getURL('range-coordinator.js'),
        'shimweave-range-v1',
      );
    } catch {
      // Dedicated Worker 会建立本地调度器；降级不改变媒体字节的执行位置。
    }
    const message: MediaWorkerInitMessage = {
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'init',
      sessionId: this.sessionId,
      source: options.source,
      ...(sharedWorker ? { coordinatorPort: sharedWorker.port } : {}),
    };
    this.worker.postMessage(message, sharedWorker ? [sharedWorker.port] : []);
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  async describe(): Promise<MediaDescriptor> {
    await this.readyPromise;
    if (this.terminalError) throw this.terminalError;
    if (this.closePromise) throw new MediaWorkerClientClosedError();
    const requestId = String(this.sequence++);
    const result = new Promise<MediaDescriptor>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.worker.postMessage({ protocol: MEDIA_WORKER_PROTOCOL, type: 'describe', requestId });
    return result;
  }

  async startStream(options: MediaWorkerStreamOptions = {}): Promise<MediaWorkerStream> {
    await this.readyPromise;
    if (this.terminalError) throw this.terminalError;
    if (this.closePromise) throw new MediaWorkerClientClosedError();
    if (this.activeStream) throw new MediaWorkerStreamActiveError();
    if (
      options.startSeconds !== undefined &&
      (!Number.isFinite(options.startSeconds) || options.startSeconds < 0)
    ) {
      throw new RangeError('startSeconds must not be negative');
    }

    const requestId = String(this.sequence++);
    const state: StreamState = {
      requestId,
      ready: createDeferred<MediaWorkerStream>(),
      completion: createDeferred<void>(),
      cancelled: false,
      ended: false,
    };
    void state.completion.promise.catch(() => undefined);
    this.activeStream = state;
    this.worker.postMessage({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'start-stream',
      requestId,
      ...(options.outputAudio ? { outputAudio: options.outputAudio } : {}),
      ...(options.videoTrackId ? { videoTrackId: options.videoTrackId } : {}),
      ...(options.audioTrackId ? { audioTrackId: options.audioTrackId } : {}),
      ...(options.startSeconds !== undefined ? { startSeconds: options.startSeconds } : {}),
    });
    return state.ready.promise;
  }

  /** 取消已经就绪或仍在建立中的媒体流，并等待 Worker 释放流槽位。 */
  cancelActiveStream(): Promise<void> {
    const state = this.activeStream;
    return state ? this.cancelStream(state) : Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.terminalError) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    }).finally(() => this.worker.terminate());
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.rejectReady(new MediaWorkerClientClosedError());
    this.rejectAll(new MediaWorkerClientClosedError());
    this.rejectStream(new MediaWorkerClientClosedError());
    this.worker.postMessage({ protocol: MEDIA_WORKER_PROTOCOL, type: 'close' });
    this.closeTimer = setTimeout(() => this.resolveClose(), 2_000);
    return this.closePromise;
  }

  private onMessage(value: unknown): void {
    if (!isHostMessage(value)) return;
    if (value.type === 'ready') {
      if (value.sessionId !== this.sessionId || this.closePromise) return;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.schedulerMode = value.schedulerMode;
      this.resolveReady();
      return;
    }
    if (value.type === 'closed') {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.resolveClose();
      return;
    }
    if (value.type === 'descriptor') {
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      this.pending.delete(value.requestId);
      pending.resolve(value.descriptor);
      return;
    }
    if (value.type === 'stream-ready') {
      const state = this.activeStream;
      if (!state || state.requestId !== value.requestId || state.ended) return;
      state.mimeType = value.mimeType;
      state.ready.resolve({
        mimeType: value.mimeType,
        ...(value.durationSeconds !== undefined ? { durationSeconds: value.durationSeconds } : {}),
        timelineOffsetSeconds: value.timelineOffsetSeconds,
        initialPositionSeconds: value.initialPositionSeconds,
        completion: state.completion.promise,
        read: () => this.readStream(state),
        cancel: () => this.cancelStream(state),
      });
      return;
    }
    if (value.type === 'stream-chunk') {
      this.receiveChunk(value.requestId, value.chunkId, value.bytes);
      return;
    }
    if (value.type === 'stream-complete') {
      this.completeStream(value.requestId);
      return;
    }
    const error = new MediaWorkerRemoteError(value.code, value.message);
    if (value.requestId) {
      const pending = this.pending.get(value.requestId);
      if (pending) {
        this.pending.delete(value.requestId);
        pending.reject(error);
        return;
      }
      if (this.activeStream?.requestId === value.requestId) this.rejectStream(error);
      return;
    }
    this.fail(error);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.rejectReady(error);
    this.rejectAll(error);
    this.rejectStream(error);
    this.resolveClose();
    this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private readStream(state: StreamState): Promise<MediaWorkerStreamChunk | undefined> {
    if (state.deliveredChunkId) throw new MediaWorkerChunkPendingAckError();
    if (state.queuedChunk) {
      const chunk = state.queuedChunk;
      delete state.queuedChunk;
      return Promise.resolve(this.createChunk(state, chunk.chunkId, chunk.bytes));
    }
    if (state.ended) return Promise.resolve(undefined);
    if (state.readWaiter) throw new MediaWorkerConcurrentReadError();
    state.readWaiter = createDeferred<MediaWorkerStreamChunk | undefined>();
    return state.readWaiter.promise;
  }

  private receiveChunk(requestId: string, chunkId: string, bytes: ArrayBuffer): void {
    const state = this.activeStream;
    if (!state || state.requestId !== requestId || state.ended || state.cancelled) return;
    if (!state.mimeType || state.queuedChunk || state.deliveredChunkId) {
      this.cancelAndRejectStream(state, new MediaWorkerProtocolError());
      return;
    }
    if (state.readWaiter) {
      const waiter = state.readWaiter;
      delete state.readWaiter;
      waiter.resolve(this.createChunk(state, chunkId, bytes));
      return;
    }
    state.queuedChunk = { chunkId, bytes };
  }

  private createChunk(
    state: StreamState,
    chunkId: string,
    bytes: ArrayBuffer,
  ): MediaWorkerStreamChunk {
    state.deliveredChunkId = chunkId;
    let acknowledged = false;
    return {
      bytes: new Uint8Array(bytes),
      acknowledge: () => {
        if (acknowledged) return;
        acknowledged = true;
        if (state.deliveredChunkId === chunkId) delete state.deliveredChunkId;
        if (state.ended || state.cancelled || this.closePromise || this.terminalError) return;
        this.worker.postMessage({
          protocol: MEDIA_WORKER_PROTOCOL,
          type: 'append-ack',
          requestId: state.requestId,
          chunkId,
        });
      },
    };
  }

  private cancelStream(state: StreamState): Promise<void> {
    if (state.ended) return state.completion.promise;
    if (!state.cancelled) {
      state.cancelled = true;
      delete state.queuedChunk;
      delete state.deliveredChunkId;
      this.worker.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'cancel-stream',
        requestId: state.requestId,
      });
    }
    return state.completion.promise;
  }

  private completeStream(requestId: string): void {
    const state = this.activeStream;
    if (!state || state.requestId !== requestId || state.ended) return;
    state.ended = true;
    delete state.queuedChunk;
    delete state.deliveredChunkId;
    state.readWaiter?.resolve(undefined);
    delete state.readWaiter;
    if (!state.mimeType) {
      state.ready.reject(
        state.cancelled ? new MediaWorkerStreamCancelledError() : new MediaWorkerProtocolError(),
      );
    }
    state.completion.resolve();
    this.activeStream = undefined;
  }

  private rejectStream(error: Error): void {
    const state = this.activeStream;
    if (!state || state.ended) return;
    state.ended = true;
    delete state.queuedChunk;
    delete state.deliveredChunkId;
    state.ready.reject(error);
    state.readWaiter?.reject(error);
    delete state.readWaiter;
    state.completion.reject(error);
    this.activeStream = undefined;
  }

  private cancelAndRejectStream(state: StreamState, error: Error): void {
    if (!state.cancelled && !this.closePromise && !this.terminalError) {
      this.worker.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'cancel-stream',
        requestId: state.requestId,
      });
    }
    this.rejectStream(error);
  }
}

export class MediaWorkerConnectionError extends Error {
  constructor() {
    super('Media worker connection failed');
    this.name = 'MediaWorkerConnectionError';
  }
}

export class MediaWorkerReadyTimeoutError extends Error {
  constructor() {
    super('Media worker did not become ready in time');
    this.name = 'MediaWorkerReadyTimeoutError';
  }
}

export class MediaWorkerClientClosedError extends Error {
  constructor() {
    super('Media worker client is closed');
    this.name = 'MediaWorkerClientClosedError';
  }
}

export class MediaWorkerRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaWorkerRemoteError';
  }
}

export class MediaWorkerStreamActiveError extends Error {
  constructor() {
    super('A media stream is already active');
    this.name = 'MediaWorkerStreamActiveError';
  }
}

export class MediaWorkerStreamCancelledError extends Error {
  constructor() {
    super('Media worker stream was cancelled');
    this.name = 'MediaWorkerStreamCancelledError';
  }
}

export class MediaWorkerChunkPendingAckError extends Error {
  constructor() {
    super('The previous media chunk has not been acknowledged');
    this.name = 'MediaWorkerChunkPendingAckError';
  }
}

export class MediaWorkerConcurrentReadError extends Error {
  constructor() {
    super('Only one media stream read may be pending');
    this.name = 'MediaWorkerConcurrentReadError';
  }
}

export class MediaWorkerProtocolError extends Error {
  constructor() {
    super('Media worker stream protocol is out of order');
    this.name = 'MediaWorkerProtocolError';
  }
}

const defaultWorkerFactory = createExtensionFrameWorker;

const defaultSharedWorkerFactory = (():
  | MediaWorkerClientOptions['createSharedWorker']
  | undefined => {
  if (typeof SharedWorker !== 'function') return undefined;
  return (url, name) => new SharedWorker(url, { type: 'module', name });
})();

const validateOptions = (options: MediaWorkerClientOptions): void => {
  if (options.source.sourceId.trim() === '') throw new TypeError('sourceId must not be empty');
  validateMediaUrl(options.source.access.url);
  if (options.source.nativePlaybackUrl) validateMediaUrl(options.source.nativePlaybackUrl);
};

const validateMediaUrl = (value: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Media URL must use HTTP or HTTPS');
  }
};

const isHostMessage = (value: unknown): value is MediaWorkerHostMessage => {
  if (!isRecord(value) || value.protocol !== MEDIA_WORKER_PROTOCOL) return false;
  if (value.type === 'closed') return true;
  if (value.type === 'ready') {
    return (
      nonEmptyString(value.sessionId) &&
      (value.schedulerMode === 'shared' || value.schedulerMode === 'local')
    );
  }
  if (value.type === 'descriptor') {
    return nonEmptyString(value.requestId) && isRecord(value.descriptor);
  }
  if (value.type === 'stream-ready') {
    return (
      nonEmptyString(value.requestId) &&
      nonEmptyString(value.mimeType) &&
      (value.durationSeconds === undefined || finiteNonNegativeNumber(value.durationSeconds)) &&
      finiteNumber(value.timelineOffsetSeconds) &&
      finiteNonNegativeNumber(value.initialPositionSeconds)
    );
  }
  if (value.type === 'stream-chunk') {
    return (
      nonEmptyString(value.requestId) &&
      nonEmptyString(value.chunkId) &&
      value.bytes instanceof ArrayBuffer
    );
  }
  if (value.type === 'stream-complete') return nonEmptyString(value.requestId);
  if (value.type === 'error') {
    return (
      nonEmptyString(value.code) &&
      typeof value.message === 'string' &&
      (value.requestId === undefined || nonEmptyString(value.requestId))
    );
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const finiteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve: Deferred<T>['resolve'] = () => undefined;
  let reject: Deferred<T>['reject'] = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
