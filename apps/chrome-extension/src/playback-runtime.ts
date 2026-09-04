import type {
  AudioTranscodeOutput,
  MediaDescriptor,
  MediaSourceDescriptor,
  PlanningResult,
  PlaybackIntent,
  PlaybackPlan,
  SampleCapabilityEvidence,
} from '@shimweave/contracts';
import {
  MediaWorkerClient,
  MediaWorkerRemoteError,
  type MediaWorkerStream,
  MediaWorkerStreamCancelledError,
} from './media-worker-client.js';
import {
  MseBufferQuotaExceededError,
  MsePlaybackController,
  type MsePlaybackSession,
  MsePlaybackStoppedError,
  MseSeekTargetUnavailableError,
  MseSourceBufferError,
  MseTypeUnsupportedError,
} from './mse-controller.js';

export interface BrowserPlaybackRequest {
  source: MediaSourceDescriptor;
  mediaElement: HTMLMediaElement;
  preferredAudioTrackId?: string;
  preferredSubtitleTrackId?: string;
  startSeconds?: number;
  /** 媒体描述完成后立即发布只读事实，使启动失败也能展示准确格式。 */
  onDescriptor?(descriptor: MediaDescriptor): void;
}

export interface ActiveBrowserPlayback {
  readonly descriptor: MediaDescriptor;
  readonly plan: PlaybackPlan;
  readonly completion: Promise<void>;
  stop(): Promise<void>;
}

interface CapabilityRuntimePort {
  plan(intent: PlaybackIntent): Promise<PlanningResult>;
  recordSample(evidence: SampleCapabilityEvidence): Promise<void>;
}

interface MediaWorkerPort {
  whenReady(): Promise<void>;
  describe(): Promise<MediaDescriptor>;
  startStream(options: {
    outputAudio?: AudioTranscodeOutput;
    videoTrackId?: string;
    audioTrackId?: string;
    startSeconds?: number;
  }): Promise<MediaWorkerStream>;
  close(): Promise<void>;
}

interface MseControllerPort {
  start(stream: MediaWorkerStream): Promise<MsePlaybackSession>;
  stop(): Promise<void>;
}

export interface BrowserPlaybackRuntimeOptions {
  capabilities: CapabilityRuntimePort;
  createWorker?: (source: MediaSourceDescriptor) => MediaWorkerPort;
  createMseController?: (mediaElement: HTMLMediaElement) => MseControllerPort;
  now?: () => number;
  steadyPlaybackSeconds?: number;
}

interface PendingPlayback {
  generation: number;
  sourceId: string;
  worker: MediaWorkerPort;
  abort: AbortController;
  release(): Promise<void>;
}

interface ActivePlaybackState extends ActiveBrowserPlayback {
  generation: number;
  sourceId: string;
}

/**
 * BrowserPlaybackRuntime 把能力规划、媒体 Worker 和浏览器播放表面串成单会话状态机。
 * 新播放会先撤销旧会话，迟到的描述、分片和样本不得接管当前媒体元素。
 */
export class BrowserPlaybackRuntime {
  private readonly capabilities: CapabilityRuntimePort;
  private readonly createWorker: NonNullable<BrowserPlaybackRuntimeOptions['createWorker']>;
  private readonly createMseController: NonNullable<
    BrowserPlaybackRuntimeOptions['createMseController']
  >;
  private readonly now: () => number;
  private readonly steadyPlaybackSeconds: number;
  private generation = 0;
  private pending: PendingPlayback | undefined;
  private active: ActivePlaybackState | undefined;

  constructor(options: BrowserPlaybackRuntimeOptions) {
    this.capabilities = options.capabilities;
    this.createWorker =
      options.createWorker ??
      ((source) =>
        new MediaWorkerClient({
          source,
        }));
    this.createMseController =
      options.createMseController ??
      ((mediaElement) => new MsePlaybackController({ mediaElement }));
    this.now = options.now ?? Date.now;
    this.steadyPlaybackSeconds = options.steadyPlaybackSeconds ?? 5;
    if (!Number.isFinite(this.steadyPlaybackSeconds) || this.steadyPlaybackSeconds <= 0) {
      throw new RangeError('steadyPlaybackSeconds must be greater than zero');
    }
  }

  async start(request: BrowserPlaybackRequest): Promise<ActiveBrowserPlayback> {
    validateRequest(request);
    const generation = ++this.generation;
    await this.stopCurrent();
    const worker = this.createWorker(request.source);
    const pending: PendingPlayback = {
      generation,
      sourceId: request.source.sourceId,
      worker,
      abort: new AbortController(),
      release: onceAsync(() => worker.close()),
    };
    this.pending = pending;

    try {
      await worker.whenReady();
      const descriptor = await worker.describe();
      this.assertCurrent(generation);
      request.onDescriptor?.(descriptor);
      const result = await this.capabilities.plan({
        media: descriptor,
        nativeSourceUrlAvailable: request.source.nativePlaybackUrl !== undefined,
        ...(request.preferredAudioTrackId
          ? { preferredAudioTrackId: request.preferredAudioTrackId }
          : {}),
        ...(request.preferredSubtitleTrackId
          ? { preferredSubtitleTrackId: request.preferredSubtitleTrackId }
          : {}),
        ...(request.startSeconds !== undefined ? { startSeconds: request.startSeconds } : {}),
      });
      this.assertCurrent(generation);
      const plan = executablePlan(result);
      const observer = new PlaybackEvidenceObserver({
        mediaElement: request.mediaElement,
        plan,
        record: (evidence) => this.capabilities.recordSample(evidence),
        now: this.now,
        steadyPlaybackSeconds: this.steadyPlaybackSeconds,
      });

      const state =
        plan.strategy === 'native'
          ? await this.startNative(pending, request, descriptor, plan, observer)
          : await this.startMse(pending, request, descriptor, plan, observer);
      this.assertCurrent(generation);
      if (this.pending === pending) this.pending = undefined;
      this.active = state;
      void state.completion.then(
        () => this.releaseSettled(state),
        () => this.releaseSettled(state),
      );
      return publicPlayback(state);
    } catch (error) {
      if (this.pending === pending) this.pending = undefined;
      await pending.release().catch(() => undefined);
      if (generation !== this.generation) throw new BrowserPlaybackSupersededError();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    await this.stopCurrent();
  }

  private async startNative(
    pending: PendingPlayback,
    request: BrowserPlaybackRequest,
    descriptor: MediaDescriptor,
    plan: PlaybackPlan,
    observer: PlaybackEvidenceObserver,
  ): Promise<ActivePlaybackState> {
    const closeWorker = pending.release;
    const nativePlaybackUrl = request.source.nativePlaybackUrl;
    if (!nativePlaybackUrl) throw new BrowserPlaybackUnsupportedError('Native URL is unavailable');
    observer.start();
    request.mediaElement.src = nativePlaybackUrl;
    request.mediaElement.load();
    const release = onceAsync(async () => {
      observer.stop();
      detachNativeMedia(request.mediaElement, nativePlaybackUrl);
      await closeWorker();
    });
    pending.release = release;
    try {
      if ((request.startSeconds ?? 0) > 0) {
        await waitForMetadata(request.mediaElement, pending.abort.signal);
        this.assertCurrent(pending.generation);
        request.mediaElement.currentTime = request.startSeconds ?? 0;
      }
      await request.mediaElement.play();
      this.assertCurrent(pending.generation);
      await closeWorker();
    } catch (error) {
      pending.generation === this.generation ? observer.fail(error) : observer.stop();
      await release().catch(() => undefined);
      throw error;
    }
    return this.createActiveState(
      pending.generation,
      pending.sourceId,
      descriptor,
      plan,
      observer,
      release,
    );
  }

  private async startMse(
    pending: PendingPlayback,
    request: BrowserPlaybackRequest,
    descriptor: MediaDescriptor,
    plan: PlaybackPlan,
    observer: PlaybackEvidenceObserver,
  ): Promise<ActivePlaybackState> {
    const worker = pending.worker;
    const closeWorker = pending.release;
    const streamOptions = (startSeconds: number | undefined) => ({
      videoTrackId: plan.videoTrackId,
      ...(plan.audioTrackId ? { audioTrackId: plan.audioTrackId } : {}),
      ...(plan.outputAudio ? { outputAudio: plan.outputAudio } : {}),
      ...(startSeconds !== undefined ? { startSeconds } : {}),
    });
    const stream = await worker.startStream(streamOptions(request.startSeconds));
    this.assertCurrent(pending.generation);
    const initialController = this.createMseController(request.mediaElement);
    let controller: MseControllerPort | undefined = initialController;
    let desiredSeekSeconds: number | undefined;
    let seekLoop: Promise<void> | undefined;
    let released = false;
    let suppressSeekEvents = false;

    const observeCompletion = (playback: MsePlaybackSession): void => {
      void playback.completion.catch((error: unknown) => observer.fail(error));
    };
    const restartAt = async (startSeconds: number): Promise<void> => {
      const previous = controller;
      controller = undefined;
      suppressSeekEvents = true;
      try {
        await previous?.stop();
      } finally {
        suppressSeekEvents = false;
      }
      if (released || desiredSeekSeconds !== undefined) return;

      const nextStream = await worker.startStream(streamOptions(startSeconds));
      if (released || desiredSeekSeconds !== undefined) {
        await nextStream.cancel();
        return;
      }
      const nextController = this.createMseController(request.mediaElement);
      controller = nextController;
      const nextPlayback = await nextController.start(nextStream);
      observer.prepareRebuiltSeek(startSeconds);
      observeCompletion(nextPlayback);
    };
    const drainSeeks = async (): Promise<void> => {
      while (!released && desiredSeekSeconds !== undefined) {
        const target = desiredSeekSeconds;
        desiredSeekSeconds = undefined;
        await restartAt(target);
      }
    };
    const scheduleSeek = (target: number): void => {
      desiredSeekSeconds = target;
      if (seekLoop) return;
      seekLoop = drainSeeks()
        .catch((error: unknown) => {
          if (!released) observer.fail(error);
        })
        .finally(() => {
          seekLoop = undefined;
          if (!released && desiredSeekSeconds !== undefined) scheduleSeek(desiredSeekSeconds);
        });
    };
    const onSeeking = (): void => {
      const target = request.mediaElement.currentTime;
      if (suppressSeekEvents && request.mediaElement.readyState === 0 && target === 0) return;
      if (
        !Number.isFinite(target) ||
        target < 0 ||
        mediaPositionIsBuffered(request.mediaElement, target)
      ) {
        return;
      }
      scheduleSeek(target);
    };
    const release = onceAsync(async () => {
      released = true;
      desiredSeekSeconds = undefined;
      request.mediaElement.removeEventListener('seeking', onSeeking);
      observer.stop();
      await Promise.allSettled([controller?.stop(), closeWorker()]);
      await seekLoop?.catch(() => undefined);
    });
    pending.release = release;
    observer.start();
    let playback: MsePlaybackSession;
    try {
      playback = await initialController.start(stream);
      this.assertCurrent(pending.generation);
    } catch (error) {
      pending.generation === this.generation ? observer.fail(error) : observer.stop();
      await release().catch(() => undefined);
      throw error;
    }
    observeCompletion(playback);
    request.mediaElement.addEventListener('seeking', onSeeking);
    return this.createActiveState(
      pending.generation,
      pending.sourceId,
      descriptor,
      plan,
      observer,
      release,
    );
  }

  private createActiveState(
    generation: number,
    sourceId: string,
    descriptor: MediaDescriptor,
    plan: PlaybackPlan,
    observer: PlaybackEvidenceObserver,
    release: () => Promise<void>,
  ): ActivePlaybackState {
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        observer.stop();
        await release();
      })();
      return stopPromise;
    };
    return {
      generation,
      sourceId,
      descriptor,
      plan,
      completion: observer.completion,
      stop,
    };
  }

  private async stopCurrent(): Promise<void> {
    const pending = this.pending;
    const active = this.active;
    this.pending = undefined;
    this.active = undefined;
    pending?.abort.abort(new BrowserPlaybackSupersededError());
    await Promise.allSettled([pending?.release(), active?.stop()]);
  }

  private async releaseSettled(state: ActivePlaybackState): Promise<void> {
    await state.stop();
    if (this.active === state) this.active = undefined;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new BrowserPlaybackSupersededError();
  }
}

class PlaybackEvidenceObserver {
  readonly completion: Promise<void>;

  private readonly mediaElement: HTMLMediaElement;
  private readonly plan: PlaybackPlan;
  private readonly record: (evidence: SampleCapabilityEvidence) => Promise<void>;
  private readonly now: () => number;
  private readonly steadyPlaybackSeconds: number;
  private resolveCompletion: () => void = () => undefined;
  private rejectCompletion: (error: unknown) => void = () => undefined;
  private started = false;
  private stopped = false;
  private firstFrameAt: number | undefined;
  private seekPending = false;
  private seekSettled = false;
  private seekTarget: number | undefined;
  private firstFrameRecorded = false;
  private steadyRecorded = false;
  private seekRecorded = false;

  constructor(options: {
    mediaElement: HTMLMediaElement;
    plan: PlaybackPlan;
    record(evidence: SampleCapabilityEvidence): Promise<void>;
    now(): number;
    steadyPlaybackSeconds: number;
  }) {
    this.mediaElement = options.mediaElement;
    this.plan = options.plan;
    this.record = options.record;
    this.now = options.now;
    this.steadyPlaybackSeconds = options.steadyPlaybackSeconds;
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => undefined);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.mediaElement.addEventListener('playing', this.onPlaying);
    this.mediaElement.addEventListener('timeupdate', this.onTimeUpdate);
    this.mediaElement.addEventListener('seeking', this.onSeeking);
    this.mediaElement.addEventListener('seeked', this.onSeeked);
    this.mediaElement.addEventListener('ended', this.onEnded);
    this.mediaElement.addEventListener('error', this.onMediaError);
  }

  fail(error: unknown): void {
    if (this.stopped) return;
    const failureClass = classifyPlaybackFailure(error);
    this.emit(
      failureClass.support === 'unknown'
        ? { support: 'unknown', failureClass: failureClass.failureClass }
        : { support: 'unsupported', failureClass: failureClass.failureClass },
    );
    this.cleanup();
    this.rejectCompletion(error);
  }

  stop(): void {
    if (this.stopped) return;
    if (!this.firstFrameRecorded) this.emit({ support: 'unknown', failureClass: 'cancelled' });
    this.cleanup();
    this.resolveCompletion();
  }

  private readonly onPlaying = (): void => {
    this.recordFirstFrame();
  };

  private readonly onTimeUpdate = (): void => {
    if (!this.firstFrameRecorded && this.mediaElement.readyState >= 2) this.recordFirstFrame();
    if (
      this.seekPending &&
      this.seekSettled &&
      !this.mediaElement.seeking &&
      this.mediaElement.readyState >= 2 &&
      this.seekTarget !== undefined &&
      Math.abs(this.mediaElement.currentTime - this.seekTarget) >= 0.05
    ) {
      this.recordSeekResume();
    }
    if (
      !this.steadyRecorded &&
      this.firstFrameAt !== undefined &&
      this.mediaElement.currentTime - this.firstFrameAt >= this.steadyPlaybackSeconds
    ) {
      this.steadyRecorded = true;
      this.emit({ support: 'supported', milestone: 'steady-playback' });
    }
  };

  private readonly onSeeking = (): void => {
    if (!this.firstFrameRecorded || this.seekPending) return;
    this.seekPending = true;
    this.seekSettled = false;
    this.seekTarget = this.mediaElement.currentTime;
  };

  private readonly onSeeked = (): void => {
    if (this.seekPending) this.seekSettled = true;
  };

  /** 流重建完成后，只接受新时间轴产生的 seeked 与后续帧推进作为成功证据。 */
  prepareRebuiltSeek(targetSeconds: number): void {
    if (!this.seekPending) return;
    this.seekTarget = targetSeconds;
    this.seekSettled = false;
  }

  private readonly onEnded = (): void => {
    this.cleanup();
    this.resolveCompletion();
  };

  private readonly onMediaError = (): void => {
    this.fail(new BrowserMediaElementError(this.mediaElement.error?.code));
  };

  private recordFirstFrame(): void {
    if (this.firstFrameRecorded) return;
    this.firstFrameRecorded = true;
    this.firstFrameAt = this.mediaElement.currentTime;
    this.emit({ support: 'supported', milestone: 'first-frame' });
  }

  private recordSeekResume(): void {
    if (!this.seekPending || this.seekRecorded) return;
    this.seekPending = false;
    this.seekRecorded = true;
    this.emit({ support: 'supported', milestone: 'seek-resume' });
  }

  private emit(
    outcome:
      | { support: 'supported'; milestone: 'first-frame' | 'steady-playback' | 'seek-resume' }
      | { support: 'unsupported'; failureClass: 'format' | 'decode' | 'append' }
      | { support: 'unknown'; failureClass: 'network' | 'quota' | 'cancelled' },
  ): void {
    const evidence = {
      kind: 'sample' as const,
      path: this.plan.path,
      configurationKey: this.plan.configurationKey,
      mediaFingerprint: this.plan.mediaFingerprint,
      observedAt: this.now(),
      ...outcome,
    } satisfies SampleCapabilityEvidence;
    void this.record(evidence).catch(() => undefined);
  }

  private cleanup(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.mediaElement.removeEventListener('playing', this.onPlaying);
    this.mediaElement.removeEventListener('timeupdate', this.onTimeUpdate);
    this.mediaElement.removeEventListener('seeking', this.onSeeking);
    this.mediaElement.removeEventListener('seeked', this.onSeeked);
    this.mediaElement.removeEventListener('ended', this.onEnded);
    this.mediaElement.removeEventListener('error', this.onMediaError);
  }
}

const executablePlan = (result: PlanningResult): PlaybackPlan => {
  if (result.status === 'ready') return result.plan;
  if (
    result.status === 'probe-required' &&
    result.candidate &&
    result.probes.some((probe) => probe.kind === 'sample-playback')
  ) {
    return result.candidate;
  }
  if (result.status === 'unsupported') throw new BrowserPlaybackUnsupportedError(result.reason);
  throw new BrowserPlaybackProbeRequiredError(result.probes.map((probe) => probe.kind));
};

const publicPlayback = (state: ActivePlaybackState): ActiveBrowserPlayback => ({
  descriptor: state.descriptor,
  plan: state.plan,
  completion: state.completion,
  stop: state.stop,
});

const waitForMetadata = (mediaElement: HTMLMediaElement, signal: AbortSignal): Promise<void> => {
  if (mediaElement.readyState >= 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      mediaElement.removeEventListener('loadedmetadata', onMetadata);
      mediaElement.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new BrowserMediaElementError(mediaElement.error?.code));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new BrowserPlaybackSupersededError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    mediaElement.addEventListener('loadedmetadata', onMetadata, { once: true });
    mediaElement.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const onceAsync = (operation: () => Promise<void>): (() => Promise<void>) => {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= operation();
    return pending;
  };
};

const detachNativeMedia = (mediaElement: HTMLMediaElement, url: string): void => {
  if (mediaElement.src !== url) return;
  mediaElement.pause();
  mediaElement.removeAttribute('src');
  mediaElement.load();
};

const mediaPositionIsBuffered = (mediaElement: HTMLMediaElement, position: number): boolean => {
  const buffered = mediaElement.buffered;
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= position + 0.05 && buffered.end(index) > position) return true;
  }
  return false;
};

const validateRequest = (request: BrowserPlaybackRequest): void => {
  if (request.source.sourceId.trim() === '') throw new TypeError('sourceId must not be empty');
  validateMediaUrl(request.source.access.url);
  if (request.source.nativePlaybackUrl) validateMediaUrl(request.source.nativePlaybackUrl);
  if (
    request.startSeconds !== undefined &&
    (!Number.isFinite(request.startSeconds) || request.startSeconds < 0)
  ) {
    throw new RangeError('startSeconds must not be negative');
  }
};

const validateMediaUrl = (value: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Media URL must use HTTP or HTTPS');
  }
};

const classifyPlaybackFailure = (
  error: unknown,
):
  | { support: 'unsupported'; failureClass: 'format' | 'decode' | 'append' }
  | { support: 'unknown'; failureClass: 'network' | 'quota' | 'cancelled' } => {
  if (error instanceof BrowserMediaElementError) {
    if (error.code === 3) return { support: 'unsupported', failureClass: 'decode' };
    if (error.code === 4) return { support: 'unsupported', failureClass: 'format' };
    return { support: 'unknown', failureClass: 'network' };
  }
  if (error instanceof MseTypeUnsupportedError) {
    return { support: 'unsupported', failureClass: 'format' };
  }
  if (error instanceof MseSourceBufferError || error instanceof MseSeekTargetUnavailableError) {
    return { support: 'unsupported', failureClass: 'append' };
  }
  if (error instanceof MseBufferQuotaExceededError) {
    return { support: 'unknown', failureClass: 'quota' };
  }
  if (
    error instanceof MsePlaybackStoppedError ||
    error instanceof MediaWorkerStreamCancelledError ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return { support: 'unknown', failureClass: 'cancelled' };
  }
  if (error instanceof MediaWorkerRemoteError) {
    return { support: 'unknown', failureClass: 'network' };
  }
  return { support: 'unknown', failureClass: 'network' };
};

export class BrowserPlaybackUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(`Media is unsupported: ${reason}`);
    this.name = 'BrowserPlaybackUnsupportedError';
  }
}

export class BrowserPlaybackProbeRequiredError extends Error {
  constructor(readonly probes: readonly string[]) {
    super(`Media facts are incomplete: ${probes.join(', ')}`);
    this.name = 'BrowserPlaybackProbeRequiredError';
  }
}

export class BrowserPlaybackSupersededError extends Error {
  constructor() {
    super('Playback was superseded by a newer request');
    this.name = 'BrowserPlaybackSupersededError';
  }
}

export class BrowserMediaElementError extends Error {
  constructor(readonly code: number | undefined) {
    super(`Browser media element failed${code === undefined ? '' : ` with code ${code}`}`);
    this.name = 'BrowserMediaElementError';
  }
}
