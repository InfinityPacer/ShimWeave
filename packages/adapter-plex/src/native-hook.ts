import { PLEX_NATIVE_PROTOCOL, type PlexNativeMessage } from './native-protocol.js';
import { parsePlexStartRequestIdentity } from './request-identity.js';

interface MediaElementLike {
  readonly dataset: DOMStringMap;
}

interface ShakaEventLike {
  readonly type: string;
  readonly detail?: unknown;
}

interface ShakaPlayerLike {
  load(uri: string, startTime?: number, mimeType?: string): Promise<void>;
  unload(initializeMediaSource?: boolean): Promise<void>;
  getMediaElement(): MediaElementLike | null;
  dispatchEvent(event: ShakaEventLike): boolean;
}

interface ShakaPlayerConstructor {
  readonly prototype: ShakaPlayerLike;
  readonly version?: string;
}

export interface PlexShakaRuntime {
  readonly Player: ShakaPlayerConstructor;
  readonly version: string;
  readonly createMediaErrorEvent?: (mediaErrorCode: number) => ShakaEventLike;
}

interface WebpackRuntimeRequire {
  (moduleId: string): unknown;
  readonly m?: Record<string, (...args: unknown[]) => unknown>;
}

export interface PlexNativeHookOptions {
  postMessage(message: PlexNativeMessage): void;
  createSessionId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  rejectionGraceMs?: number;
  takeoverTimeoutMs?: number;
  stopTimeoutMs?: number;
  unloadTimeoutMs?: number;
  mediaElementTimeoutMs?: number;
}

interface TrackedLoad {
  readonly requestKey: string;
  readonly sourceKey: string;
  readonly player: ShakaPlayerLike;
  mediaElement?: MediaElementLike;
  readonly takeoverStarted: Deferred<void>;
  settled: boolean;
  takeover?: ActiveTakeover;
}

interface ActiveTakeover {
  readonly sessionId: string;
  readonly noticeId: string;
  readonly outcome: Deferred<void>;
  started: boolean;
  ready: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  stopTask?: Promise<void>;
}

interface AvailableSource {
  readonly sourceKey: string;
  readonly noticeId: string;
}

const DEFAULT_REJECTION_GRACE_MS = 750;
const DEFAULT_TAKEOVER_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_UNLOAD_TIMEOUT_MS = 2_000;
const DEFAULT_MEDIA_ELEMENT_TIMEOUT_MS = 500;
const PLAYER_HOOK = Symbol.for('shimweave.plex.native-player-hook');
type LoadArguments = [string, number | undefined, string | undefined];

/**
 * PlexNativeHookController 只接管已被扩展网络层确认的 STRM 响应。
 * 未收到 source-available 的本地媒体和正常 manifest 始终使用 Shaka 原始 load。
 */
export class PlexNativeHookController {
  private readonly postMessage: PlexNativeHookOptions['postMessage'];
  private readonly createSessionId: () => string;
  private readonly schedule: NonNullable<PlexNativeHookOptions['schedule']>;
  private readonly cancelSchedule: NonNullable<PlexNativeHookOptions['cancelSchedule']>;
  private readonly rejectionGraceMs: number;
  private readonly takeoverTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly unloadTimeoutMs: number;
  private readonly mediaElementTimeoutMs: number;
  private readonly sources = new Map<string, AvailableSource>();
  private readonly loads = new Map<string, TrackedLoad>();
  private readonly stopWaiters = new Map<string, Deferred<void>>();
  private active: TrackedLoad | undefined;
  private transitionTail = Promise.resolve();
  private installedPrototype: ShakaPlayerLike | undefined;
  private originalPrototypeLoad: ShakaPlayerLike['load'] | undefined;
  private createMediaErrorEvent: PlexShakaRuntime['createMediaErrorEvent'];
  private blockedSource: { readonly sourceKey: string; readonly mediaErrorCode: 3 | 4 } | undefined;

  constructor(options: PlexNativeHookOptions) {
    this.postMessage = options.postMessage;
    this.createSessionId = options.createSessionId ?? (() => crypto.randomUUID());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.rejectionGraceMs = options.rejectionGraceMs ?? DEFAULT_REJECTION_GRACE_MS;
    this.takeoverTimeoutMs = options.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.unloadTimeoutMs = options.unloadTimeoutMs ?? DEFAULT_UNLOAD_TIMEOUT_MS;
    this.mediaElementTimeoutMs = options.mediaElementTimeoutMs ?? DEFAULT_MEDIA_ELEMENT_TIMEOUT_MS;
  }

  install(runtime: PlexShakaRuntime): boolean {
    const prototype = runtime.Player.prototype;
    const existing = (prototype as ShakaPlayerLike & { [PLAYER_HOOK]?: boolean })[PLAYER_HOOK];
    if (existing) return false;

    const originalLoad = prototype.load;
    const controller = this;
    prototype.load = function (uri: string, startTime?: number, mimeType?: string): Promise<void> {
      return controller.trackLoad(this, originalLoad, [uri, startTime, mimeType]);
    };
    Object.defineProperty(prototype, PLAYER_HOOK, { configurable: true, value: true });
    this.installedPrototype = prototype;
    this.originalPrototypeLoad = originalLoad;
    this.createMediaErrorEvent = runtime.createMediaErrorEvent;
    this.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'hook-ready',
      shakaVersion: runtime.version,
    });
    return true;
  }

  accept(message: PlexNativeMessage): void {
    if (message.sender !== 'extension-host') return;
    if (message.type === 'source-available') {
      const tracked = this.loads.get(message.requestKey);
      if (
        !tracked ||
        tracked.settled ||
        tracked.takeover ||
        tracked.sourceKey !== message.sourceKey
      ) {
        this.rejectSource(message.requestKey, message.noticeId);
        return;
      }
      const previous = this.sources.get(message.requestKey);
      if (previous && previous.noticeId !== message.noticeId) {
        this.rejectSource(message.requestKey, previous.noticeId);
      }
      this.sources.set(message.requestKey, {
        sourceKey: message.sourceKey,
        noticeId: message.noticeId,
      });
      void this.beginTakeover(tracked);
      return;
    }
    if (message.type === 'takeover-ready') {
      const tracked = this.active;
      if (
        tracked?.takeover?.sessionId !== message.sessionId ||
        tracked.takeover.stopTask !== undefined
      ) {
        return;
      }
      this.clearTakeoverTimeout(tracked.takeover);
      tracked.takeover.ready = true;
      tracked.takeover.outcome.resolve();
      return;
    }
    if (message.type === 'takeover-error') {
      const tracked = this.active;
      if (tracked?.takeover?.sessionId !== message.sessionId) return;
      void this.handleTakeoverError(tracked, message.code);
      return;
    }
    if (message.type === 'takeover-stopped') {
      this.stopWaiters.get(message.sessionId)?.resolve();
    }
  }

  dispose(): void {
    void this.stopActive();
    const prototype = this.installedPrototype;
    if (prototype && this.originalPrototypeLoad) {
      prototype.load = this.originalPrototypeLoad;
      delete (prototype as ShakaPlayerLike & { [PLAYER_HOOK]?: boolean })[PLAYER_HOOK];
    }
    this.loads.clear();
    this.sources.clear();
    this.blockedSource = undefined;
    this.createMediaErrorEvent = undefined;
    this.installedPrototype = undefined;
    this.originalPrototypeLoad = undefined;
  }

  private trackLoad(
    player: ShakaPlayerLike,
    originalLoad: ShakaPlayerLike['load'],
    args: LoadArguments,
  ): Promise<void> {
    const identity = parsePlexStartRequestIdentity(args[0]);
    if (!identity) return invokeLoad(originalLoad, player, args);
    if (this.blockedSource?.sourceKey === identity.sourceKey) {
      return this.rejectBlockedLoad(player, this.blockedSource);
    }
    this.blockedSource = undefined;
    const active = this.active;
    if (
      active?.player === player &&
      !active.settled &&
      active.sourceKey === identity.sourceKey &&
      active.takeover &&
      active.takeover.stopTask === undefined
    ) {
      return active.takeover.outcome.promise;
    }

    let loading: Promise<void> | undefined;
    const setup = this.transitionTail.then(async () => {
      await this.stopActive();
      this.releasePlayerLoads(player);
      loading = this.startTrackedLoad(player, originalLoad, args, identity);
    });
    this.transitionTail = setup.catch(() => undefined);
    return setup.then(() => loading ?? Promise.reject(new Error('Plex load setup failed')));
  }

  private startTrackedLoad(
    player: ShakaPlayerLike,
    originalLoad: ShakaPlayerLike['load'],
    args: LoadArguments,
    identity: NonNullable<ReturnType<typeof parsePlexStartRequestIdentity>>,
  ): Promise<void> {
    const tracked: TrackedLoad = {
      requestKey: identity.requestKey,
      sourceKey: identity.sourceKey,
      player,
      takeoverStarted: deferred<void>(),
      settled: false,
    };
    this.loads.set(tracked.requestKey, tracked);

    let original: Promise<void>;
    try {
      original = Promise.resolve(invokeLoad(originalLoad, player, args));
    } catch (error) {
      original = Promise.reject(error);
    }
    if (this.sources.get(tracked.requestKey)?.sourceKey === tracked.sourceKey) {
      void this.beginTakeover(tracked);
    }

    return original.then(
      () => {
        if (tracked.takeover) return tracked.takeover.outcome.promise;
        this.releaseTrackedLoad(tracked);
      },
      async (error: unknown) => {
        if (!tracked.takeover) {
          await Promise.race([
            tracked.takeoverStarted.promise,
            delay(this.rejectionGraceMs, this.schedule),
          ]);
        }
        if (tracked.takeover) {
          return tracked.takeover.outcome.promise.catch(() => Promise.reject(error));
        }
        this.releaseTrackedLoad(tracked);
        throw error;
      },
    );
  }

  private async beginTakeover(tracked: TrackedLoad): Promise<void> {
    if (tracked.settled || tracked.takeover || this.loads.get(tracked.requestKey) !== tracked)
      return;
    const source = this.sources.get(tracked.requestKey);
    if (!source || source.sourceKey !== tracked.sourceKey) return;
    const mediaElement = await this.waitForMediaElement(tracked);
    if (!mediaElement || tracked.settled || this.loads.get(tracked.requestKey) !== tracked) {
      this.rejectSource(tracked.requestKey, source.noticeId);
      tracked.takeoverStarted.resolve();
      return;
    }
    this.sources.delete(tracked.requestKey);
    const sessionId = this.createSessionId();
    const takeover: ActiveTakeover = {
      sessionId,
      noticeId: source.noticeId,
      outcome: deferred<void>(),
      started: false,
      ready: false,
    };
    tracked.takeover = takeover;
    tracked.takeoverStarted.resolve();
    this.active = tracked;
    tracked.mediaElement = mediaElement;
    mediaElement.dataset.shimweaveNativeSession = sessionId;

    try {
      // Shaka 保持附着，后续 Plex load 仍可复用原 Player；仅卸载当前媒体数据面。
      await withTimeout(
        tracked.player.unload(false),
        this.unloadTimeoutMs,
        this.schedule,
        this.cancelSchedule,
        () => new PlexNativeUnloadTimeoutError(),
      );
      if (this.active !== tracked || tracked.settled) return;
      takeover.started = true;
      takeover.timeout = this.schedule(() => {
        void this.failTakeover(tracked, new PlexNativeTakeoverTimeoutError());
      }, this.takeoverTimeoutMs);
      this.postMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'takeover-start',
        requestKey: tracked.requestKey,
        noticeId: takeover.noticeId,
        sessionId,
      });
    } catch (error) {
      await this.failTakeover(tracked, error);
    }
  }

  private async failTakeover(tracked: TrackedLoad, cause: unknown): Promise<void> {
    await this.stopTakeover(tracked, cause);
  }

  private async handleTakeoverError(tracked: TrackedLoad, code: string): Promise<void> {
    const mediaErrorCode = definitiveMediaErrorCode(code);
    // 确定性格式或解码失败在当前页面会话内不再接管，并交还给站点原生错误表面展示。
    if (mediaErrorCode !== undefined) {
      this.blockedSource = { sourceKey: tracked.sourceKey, mediaErrorCode };
    }
    await this.stopTakeover(tracked, new PlexNativeTakeoverError(code));
    if (mediaErrorCode === undefined || this.blockedSource?.sourceKey !== tracked.sourceKey) {
      return;
    }
    this.dispatchMediaError(tracked.player, mediaErrorCode);
  }

  private rejectBlockedLoad(
    player: ShakaPlayerLike,
    blocked: NonNullable<PlexNativeHookController['blockedSource']>,
  ): Promise<void> {
    this.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'blocked-source-retry',
      sourceKey: blocked.sourceKey,
    });
    const event = this.dispatchMediaError(player, blocked.mediaErrorCode);
    const code = blocked.mediaErrorCode === 3 ? 'media_decode_error' : 'media_format_error';
    return Promise.reject(event?.detail ?? new PlexNativeTakeoverError(code));
  }

  private dispatchMediaError(
    player: ShakaPlayerLike,
    mediaErrorCode: 3 | 4,
  ): ShakaEventLike | undefined {
    const event = this.createMediaErrorEvent?.(mediaErrorCode);
    if (!event) return undefined;
    try {
      player.dispatchEvent(event);
    } catch {
      // Shaka 错误桥属于失败收口路径，页面实现变化不得反向破坏会话释放。
    }
    return event;
  }

  private async stopActive(): Promise<void> {
    const tracked = this.active;
    if (!tracked?.takeover) return;
    await this.stopTakeover(tracked);
  }

  private stopTakeover(tracked: TrackedLoad, cause?: unknown): Promise<void> {
    const takeover = tracked.takeover;
    if (!takeover || tracked.settled) return Promise.resolve();
    if (takeover.stopTask) return takeover.stopTask;
    takeover.stopTask = this.finishStop(tracked, takeover, cause);
    return takeover.stopTask;
  }

  private async finishStop(
    tracked: TrackedLoad,
    takeover: ActiveTakeover,
    cause: unknown,
  ): Promise<void> {
    this.clearTakeoverTimeout(takeover);
    if (!takeover.started) {
      this.releaseTrackedLoad(tracked);
      if (cause === undefined) takeover.outcome.resolve();
      else takeover.outcome.reject(cause);
      return;
    }
    const stopped = deferred<void>();
    this.stopWaiters.set(takeover.sessionId, stopped);
    this.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'takeover-stop',
      sessionId: takeover.sessionId,
    });
    await Promise.race([stopped.promise, delay(this.stopTimeoutMs, this.schedule)]);
    this.stopWaiters.delete(takeover.sessionId);
    this.releaseTrackedLoad(tracked);
    if (cause === undefined) takeover.outcome.resolve();
    else takeover.outcome.reject(cause);
  }

  private releasePlayerLoads(player: ShakaPlayerLike): void {
    for (const tracked of this.loads.values()) {
      if (tracked.player === player && tracked !== this.active) this.releaseTrackedLoad(tracked);
    }
  }

  private releaseTrackedLoad(tracked: TrackedLoad): void {
    const source = this.sources.get(tracked.requestKey);
    if (source) this.rejectSource(tracked.requestKey, source.noticeId);
    tracked.settled = true;
    if (tracked.mediaElement) delete tracked.mediaElement.dataset.shimweaveNativeSession;
    this.sources.delete(tracked.requestKey);
    if (this.loads.get(tracked.requestKey) === tracked) this.loads.delete(tracked.requestKey);
    if (this.active === tracked) this.active = undefined;
  }

  private async waitForMediaElement(tracked: TrackedLoad): Promise<MediaElementLike | undefined> {
    const immediate = tracked.player.getMediaElement();
    if (immediate || this.mediaElementTimeoutMs <= 0) return immediate ?? undefined;
    const deadline = Date.now() + this.mediaElementTimeoutMs;
    while (Date.now() < deadline && !tracked.settled) {
      await delay(10, this.schedule);
      const mediaElement = tracked.player.getMediaElement();
      if (mediaElement) return mediaElement;
    }
    return undefined;
  }

  private rejectSource(requestKey: string, noticeId: string): void {
    const current = this.sources.get(requestKey);
    if (current?.noticeId === noticeId) this.sources.delete(requestKey);
    this.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'main-hook',
      type: 'source-rejected',
      requestKey,
      noticeId,
    });
  }

  private clearTakeoverTimeout(takeover: ActiveTakeover): void {
    if (!takeover.timeout) return;
    this.cancelSchedule(takeover.timeout);
    delete takeover.timeout;
  }
}

/** 通过工厂结构和导出能力定位 Plex 内置 Shaka，不依赖 webpack 模块 ID。 */
export const findPlexShakaRuntime = (
  runtimeRequire: WebpackRuntimeRequire,
): PlexShakaRuntime | undefined => {
  for (const [moduleId, factory] of Object.entries(runtimeRequire.m ?? {})) {
    const source = Function.prototype.toString.call(factory);
    if (
      !source.includes('shaka.Player') ||
      !source.includes('NetworkingEngine') ||
      !source.includes('registerScheme')
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = runtimeRequire(moduleId);
    } catch {
      continue;
    }
    if (!isShakaRuntime(candidate)) continue;
    const createMediaErrorEvent = createShakaMediaErrorEventFactory(candidate);
    return {
      Player: candidate.Player,
      version: candidate.Player.version ?? 'unknown',
      ...(createMediaErrorEvent ? { createMediaErrorEvent } : {}),
    };
  }
  return undefined;
};

interface ShakaErrorConstructor {
  new (severity: number, category: number, code: number, ...data: unknown[]): unknown;
  readonly Severity?: { readonly CRITICAL?: number };
  readonly Category?: { readonly MEDIA?: number };
  readonly Code?: { readonly VIDEO_ERROR?: number };
}

interface ShakaFakeEventConstructor {
  new (type: string, data: Map<string, unknown>): ShakaEventLike;
}

const createShakaMediaErrorEventFactory = (
  runtime: Record<string, unknown>,
): PlexShakaRuntime['createMediaErrorEvent'] => {
  const util = runtime.util;
  if (!isRecord(util)) return undefined;
  const ErrorType = util.Error as ShakaErrorConstructor | undefined;
  const FakeEvent = util.FakeEvent as ShakaFakeEventConstructor | undefined;
  const severity = ErrorType?.Severity?.CRITICAL;
  const category = ErrorType?.Category?.MEDIA;
  const code = ErrorType?.Code?.VIDEO_ERROR;
  if (
    typeof ErrorType !== 'function' ||
    typeof FakeEvent !== 'function' ||
    typeof severity !== 'number' ||
    typeof category !== 'number' ||
    typeof code !== 'number'
  ) {
    return undefined;
  }
  return (mediaErrorCode) => {
    const detail = new ErrorType(severity, category, code, mediaErrorCode);
    return new FakeEvent('error', new Map([['detail', detail]]));
  };
};

const definitiveMediaErrorCode = (code: string): 3 | 4 | undefined => {
  if (code === 'media_decode_error') return 3;
  if (code === 'media_format_error') return 4;
  return undefined;
};

const isShakaRuntime = (
  value: unknown,
): value is { Player: ShakaPlayerConstructor; net: { NetworkingEngine: unknown } } => {
  if (!isRecord(value) || typeof value.Player !== 'function' || !isRecord(value.net)) return false;
  const prototype = value.Player.prototype;
  return (
    isRecord(prototype) &&
    typeof prototype.load === 'function' &&
    typeof prototype.unload === 'function' &&
    typeof prototype.getMediaElement === 'function' &&
    typeof value.net.NetworkingEngine === 'function'
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: Deferred<T>['resolve'] = () => undefined;
  let reject: Deferred<T>['reject'] = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const delay = (
  milliseconds: number,
  schedule: NonNullable<PlexNativeHookOptions['schedule']>,
): Promise<void> => new Promise((resolve) => schedule(resolve, milliseconds));

const withTimeout = <T>(
  operation: Promise<T>,
  milliseconds: number,
  schedule: NonNullable<PlexNativeHookOptions['schedule']>,
  cancelSchedule: NonNullable<PlexNativeHookOptions['cancelSchedule']>,
  createError: () => Error,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = schedule(() => {
      if (settled) return;
      settled = true;
      reject(createError());
    }, milliseconds);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cancelSchedule(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelSchedule(timeout);
        reject(error);
      },
    );
  });

const invokeLoad = (
  load: ShakaPlayerLike['load'],
  player: ShakaPlayerLike,
  args: LoadArguments,
): Promise<void> => load.call(player, args[0], args[1], args[2]);

export class PlexNativeTakeoverError extends Error {
  constructor(readonly code: string) {
    super(`Plex native takeover failed: ${code}`);
    this.name = 'PlexNativeTakeoverError';
  }
}

export class PlexNativeUnloadTimeoutError extends Error {
  constructor() {
    super('Plex Shaka unload timed out');
    this.name = 'PlexNativeUnloadTimeoutError';
  }
}

export class PlexNativeTakeoverTimeoutError extends Error {
  constructor() {
    super('Plex native takeover timed out');
    this.name = 'PlexNativeTakeoverTimeoutError';
  }
}
