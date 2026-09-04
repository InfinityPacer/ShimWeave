import type {
  AudioTranscodeOutput,
  MediaDescriptor,
  MediaEngineProvider,
  MediaEngineSession,
  MediaFragmentStream,
  MediaFragmentStreamOptions,
} from '@shimweave/contracts';
import { isMediaSourceDescriptor } from '@shimweave/contracts';
import {
  RangeLeaseSchedulerClient,
  RangeScheduler,
  RangeSession,
  type RangeTaskScheduler,
} from '@shimweave/core';
import { FetchRangeSource, RangeProtocolError } from '@shimweave/io-fetch';
import {
  MEDIA_WORKER_PROTOCOL,
  type MediaWorkerClientMessage,
  type MediaWorkerErrorMessage,
  type MediaWorkerHostMessage,
  type MediaWorkerInitMessage,
} from './media-worker-protocol.js';
import { MEDIA_RANGE_SCHEDULER_OPTIONS } from './range-policy.js';
import { WorkerFragmentSink } from './worker-fragment-sink.js';

const STREAM_READ_AHEAD_BYTES = 4 * 1024 * 1024;

interface SchedulerRuntime {
  mode: 'shared' | 'local';
  scheduler: RangeTaskScheduler;
  close(): Promise<void>;
}

interface ActiveStream {
  requestId: string;
  sink: WorkerFragmentSink;
  cancelled: boolean;
  stream?: MediaFragmentStream;
  completion: Promise<void>;
}

export interface MediaWorkerHostOptions {
  postMessage(message: MediaWorkerHostMessage, transfer?: Transferable[]): void;
  mediaEngine: MediaEngineProvider;
  createScheduler?: (message: MediaWorkerInitMessage) => Promise<SchedulerRuntime>;
}

/** DedicatedMediaWorkerHost 保持签名 URL 和媒体 I/O 在 Worker 内，只回传控制、描述和可转移媒体块。 */
export class DedicatedMediaWorkerHost {
  private readonly postMessage: MediaWorkerHostOptions['postMessage'];
  private readonly mediaEngine: MediaEngineProvider;
  private readonly createScheduler: NonNullable<MediaWorkerHostOptions['createScheduler']>;
  private schedulerRuntime: SchedulerRuntime | undefined;
  private mediaSession: MediaEngineSession | undefined;
  private mediaDescriptor: MediaDescriptor | undefined;
  private initializationMessage: MediaWorkerInitMessage | undefined;
  private activeStream: ActiveStream | undefined;
  private initialized = false;
  private closing: Promise<void> | undefined;

  constructor(options: MediaWorkerHostOptions) {
    this.postMessage = options.postMessage;
    this.mediaEngine = options.mediaEngine;
    this.createScheduler = options.createScheduler ?? createDefaultScheduler;
  }

  receive(value: unknown): void {
    if (!isClientMessage(value)) {
      this.sendError('invalid_request', 'Worker message is invalid');
      return;
    }
    if (value.type === 'init') {
      void this.initialize(value);
      return;
    }
    if (value.type === 'describe') {
      void this.describe(value.requestId);
      return;
    }
    if (value.type === 'start-stream') {
      this.startStream(value.requestId, {
        ...(value.outputAudio ? { outputAudio: value.outputAudio } : {}),
        ...(value.videoTrackId ? { videoTrackId: value.videoTrackId } : {}),
        ...(value.audioTrackId ? { audioTrackId: value.audioTrackId } : {}),
        ...(value.startSeconds !== undefined ? { startSeconds: value.startSeconds } : {}),
      });
      return;
    }
    if (value.type === 'append-ack') {
      this.acknowledge(value.requestId, value.chunkId);
      return;
    }
    if (value.type === 'cancel-stream') {
      void this.cancelStream(value.requestId);
      return;
    }
    void this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.release().then(() => {
      this.postMessage({ protocol: MEDIA_WORKER_PROTOCOL, type: 'closed' });
    });
    return this.closing;
  }

  private async initialize(message: MediaWorkerInitMessage): Promise<void> {
    if (this.initialized || this.closing) {
      this.sendError('invalid_request', 'Worker session is already initialized');
      return;
    }
    this.initialized = true;
    try {
      const schedulerRuntime = await this.createScheduler(message);
      if (this.closing) {
        await schedulerRuntime.close();
        return;
      }
      this.schedulerRuntime = schedulerRuntime;
      this.initializationMessage = message;
      this.mediaSession = await createMediaSession(
        message,
        schedulerRuntime.scheduler,
        this.mediaEngine,
      );
      this.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'ready',
        sessionId: message.sessionId,
        schedulerMode: schedulerRuntime.mode,
      });
    } catch {
      this.sendError('initialization_failed', 'Media worker initialization failed');
      await this.release();
    }
  }

  private async describe(requestId: string): Promise<void> {
    if (!this.mediaSession || this.closing) {
      this.sendError('not_ready', 'Media worker is not ready', requestId);
      return;
    }
    try {
      const descriptor = await this.mediaSession.describe();
      if (this.closing) return;
      this.mediaDescriptor = descriptor;
      this.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'descriptor',
        requestId,
        descriptor,
      });
    } catch (error) {
      if (!this.closing) this.sendError('probe_failed', safeErrorClassification(error), requestId);
    }
  }

  private startStream(requestId: string, options: MediaFragmentStreamOptions): void {
    if (!this.mediaSession || this.closing) {
      this.sendError('not_ready', 'Media worker is not ready', requestId);
      return;
    }
    if (this.activeStream) {
      this.sendError('stream_active', 'A media stream is already active', requestId);
      return;
    }

    const sink = new WorkerFragmentSink({
      requestId,
      postMessage: (message, transfer) => this.postMessage(message, transfer),
    });
    const active: ActiveStream = {
      requestId,
      sink,
      cancelled: false,
      completion: Promise.resolve(),
    };
    this.activeStream = active;
    active.completion = this.runStream(active, options);
  }

  private async runStream(
    active: ActiveStream,
    options: MediaFragmentStreamOptions,
  ): Promise<void> {
    let failed = false;
    const mediaSession = this.mediaSession;
    try {
      if (options.outputAudio) {
        await mediaSession?.prepareCodecs({
          outputAudio: options.outputAudio,
          ...(options.audioTrackId ? { audioTrackId: options.audioTrackId } : {}),
        });
      }
      const stream = await mediaSession?.startFragmentStream(active.sink, options);
      if (!stream) throw new Error('Media session is unavailable');
      active.stream = stream;
      if (active.cancelled || this.closing) {
        active.sink.abort(new MediaWorkerStreamCancelledError());
        await stream.cancel();
        return;
      }
      this.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'stream-ready',
        requestId: active.requestId,
        mimeType: stream.mimeType,
        ...(this.mediaDescriptor?.durationSeconds !== undefined &&
        finiteNonNegativeNumber(this.mediaDescriptor.durationSeconds)
          ? { durationSeconds: this.mediaDescriptor.durationSeconds }
          : {}),
        timelineOffsetSeconds: stream.timelineOffsetSeconds,
        initialPositionSeconds: stream.initialPositionSeconds,
      });
      await active.sink.activate();
      await stream.completion;
    } catch (error) {
      failed = !active.cancelled && !this.closing;
      if (failed) {
        await this.rebuildMediaSession(mediaSession);
        if (!this.closing) {
          this.sendError('stream_failed', safeErrorClassification(error), active.requestId);
        }
      }
    } finally {
      active.sink.abort();
      if (this.activeStream === active) this.activeStream = undefined;
      if (!failed && !active.cancelled && !this.closing) {
        this.postMessage({
          protocol: MEDIA_WORKER_PROTOCOL,
          type: 'stream-complete',
          requestId: active.requestId,
        });
      }
    }
  }

  private acknowledge(requestId: string, chunkId: string): void {
    if (this.activeStream?.requestId !== requestId) return;
    this.activeStream.sink.acknowledge(chunkId);
  }

  private async cancelStream(requestId: string): Promise<void> {
    const active = this.activeStream;
    if (!active || active.requestId !== requestId || active.cancelled) return;
    const mediaSession = this.mediaSession;
    active.cancelled = true;
    active.sink.abort(new MediaWorkerStreamCancelledError());
    await Promise.allSettled([
      active.stream?.cancel(),
      active.stream ? undefined : this.rebuildMediaSession(mediaSession),
      active.completion,
    ]);
    if (!this.closing) {
      // stream-complete 是允许客户端立即重试的边界，必须晚于输入重建和旧流释放。
      this.postMessage({
        protocol: MEDIA_WORKER_PROTOCOL,
        type: 'stream-complete',
        requestId: active.requestId,
      });
    }
  }

  private async release(): Promise<void> {
    const activeStream = this.activeStream;
    const mediaSession = this.mediaSession;
    const schedulerRuntime = this.schedulerRuntime;
    this.activeStream = undefined;
    this.mediaSession = undefined;
    this.schedulerRuntime = undefined;
    this.initializationMessage = undefined;
    if (activeStream) {
      activeStream.cancelled = true;
      activeStream.sink.abort(new MediaWorkerStreamCancelledError());
    }
    await Promise.allSettled([
      activeStream?.stream?.cancel(),
      mediaSession?.close(),
      schedulerRuntime?.close(),
      activeStream?.completion,
    ]);
  }

  /** 输入读取失败可能使解封装器保留终止状态；重建输入但复用全局调度器，保证重试不扩大并发。 */
  private async rebuildMediaSession(failedSession: MediaEngineSession | undefined): Promise<void> {
    if (
      !failedSession ||
      this.closing ||
      this.mediaSession !== failedSession ||
      !this.initializationMessage ||
      !this.schedulerRuntime
    ) {
      return;
    }
    this.mediaSession = undefined;
    await failedSession.close().catch(() => undefined);
    if (this.closing || !this.initializationMessage || !this.schedulerRuntime) return;
    try {
      this.mediaSession = await createMediaSession(
        this.initializationMessage,
        this.schedulerRuntime.scheduler,
        this.mediaEngine,
      );
    } catch {
      this.mediaSession = undefined;
    }
  }

  private sendError(
    code: MediaWorkerErrorMessage['code'],
    message: string,
    requestId?: string,
  ): void {
    this.postMessage({
      protocol: MEDIA_WORKER_PROTOCOL,
      type: 'error',
      code,
      message,
      ...(requestId ? { requestId } : {}),
    });
  }
}

const createMediaSession = async (
  message: MediaWorkerInitMessage,
  scheduler: RangeTaskScheduler,
  mediaEngine: MediaEngineProvider,
): Promise<MediaEngineSession> => {
  const source = new FetchRangeSource({
    sourceId: message.source.sourceId,
    url: message.source.access.url,
    ...(message.source.access.kind === 'controlled-http-range'
      ? {
          control: {
            requestHeaders: message.source.access.requestHeaders,
            responseUrlHeader: message.source.access.responseUrlHeader,
            ...(message.source.access.expectedStatus !== undefined
              ? { expectedStatus: message.source.access.expectedStatus }
              : {}),
          },
        }
      : {}),
  });
  const rangeSession = new RangeSession({ scheduler });
  const broker = rangeSession.createBroker(source);
  let mediaSession: MediaEngineSession;
  try {
    mediaSession = mediaEngine.createSession(broker);
  } catch (error) {
    await rangeSession.close(error).catch(() => undefined);
    throw error;
  }
  return {
    describe: () => mediaSession.describe(),
    prepareCodecs: (preparation) => mediaSession.prepareCodecs(preparation),
    startFragmentStream: (sink, options) => {
      broker.setReadAheadBytes(STREAM_READ_AHEAD_BYTES);
      return mediaSession.startFragmentStream(sink, options);
    },
    close: async () => {
      await Promise.allSettled([mediaSession.close(), rangeSession.close()]);
    },
  };
};

const createDefaultScheduler = async (
  message: MediaWorkerInitMessage,
): Promise<SchedulerRuntime> => {
  if (message.coordinatorPort) {
    try {
      const client = new RangeLeaseSchedulerClient(message.coordinatorPort);
      await client.whenReady();
      return { mode: 'shared', scheduler: client, close: () => client.close() };
    } catch {
      // SharedWorker 不可用只缩小协调范围，媒体仍在当前 Dedicated Worker 内直连源站。
    }
  }
  const scheduler = new RangeScheduler(MEDIA_RANGE_SCHEDULER_OPTIONS);
  return { mode: 'local', scheduler, close: () => scheduler.close() };
};

/** Worker 只跨上下文传递稳定错误类别和数值协议字段，不回传异常消息或签名地址。 */
const safeErrorClassification = (error: unknown): string => {
  const classifications: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current) && classifications.length < 4) {
    visited.add(current);
    if (current instanceof RangeProtocolError) {
      const details = [
        current.status === undefined ? undefined : `status_${current.status}`,
        current.expected === undefined ? undefined : `expected_${current.expected}`,
        current.actual === undefined ? undefined : `actual_${current.actual}`,
      ].filter((value): value is string => value !== undefined);
      classifications.push([`RangeProtocolError.${current.code}`, ...details].join('.'));
    } else {
      const name = safeErrorName(current.name);
      const detail = safeErrorDetail(current.message);
      classifications.push(detail ? `${name}.${detail}` : name);
    }
    current = current.cause;
  }
  return classifications.length > 0 ? classifications.join('>') : 'UnknownError';
};

const safeErrorName = (name: string): string =>
  /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error';

const safeErrorDetail = (message: string): string | undefined => {
  const detail = message.trim();
  const boundary = detail.search(/https?:\/\/|[/?&=%]/i);
  const safePrefix = (boundary >= 0 ? detail.slice(0, boundary) : detail).trim();
  if (
    safePrefix.length === 0 ||
    safePrefix.length > 200 ||
    !/^[\x20-\x7e]+$/.test(safePrefix) ||
    /\b(?:authorization|cookie|secret|signature|signed|token)\b/i.test(safePrefix)
  ) {
    return undefined;
  }
  return safePrefix.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
};

const isClientMessage = (value: unknown): value is MediaWorkerClientMessage => {
  if (
    !isRecord(value) ||
    value.protocol !== MEDIA_WORKER_PROTOCOL ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  if (value.type === 'close') return true;
  if (value.type === 'describe') return nonEmptyString(value.requestId);
  if (value.type === 'start-stream') {
    return (
      nonEmptyString(value.requestId) &&
      (value.outputAudio === undefined || isAudioTranscodeOutput(value.outputAudio)) &&
      (value.videoTrackId === undefined || nonEmptyString(value.videoTrackId)) &&
      (value.audioTrackId === undefined || nonEmptyString(value.audioTrackId)) &&
      (value.startSeconds === undefined || finiteNonNegativeNumber(value.startSeconds))
    );
  }
  if (value.type === 'append-ack') {
    return nonEmptyString(value.requestId) && nonEmptyString(value.chunkId);
  }
  if (value.type === 'cancel-stream') return nonEmptyString(value.requestId);
  if (value.type !== 'init') return false;
  if (!nonEmptyString(value.sessionId) || !isMediaSourceDescriptor(value.source)) {
    return false;
  }
  return value.coordinatorPort === undefined || isRangeLeasePort(value.coordinatorPort);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const finiteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isAudioTranscodeOutput = (value: unknown): value is AudioTranscodeOutput =>
  isRecord(value) &&
  value.codec === 'aac' &&
  nonEmptyString(value.codecString) &&
  positiveInteger(value.channels) &&
  (value.channelLayout === undefined || nonEmptyString(value.channelLayout)) &&
  positiveInteger(value.sampleRate) &&
  positiveInteger(value.bitrate);

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isRangeLeasePort = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.postMessage === 'function' &&
  typeof value.addEventListener === 'function' &&
  typeof value.removeEventListener === 'function';

class MediaWorkerStreamCancelledError extends Error {
  constructor() {
    super('Media stream was cancelled');
    this.name = 'MediaWorkerStreamCancelledError';
  }
}
