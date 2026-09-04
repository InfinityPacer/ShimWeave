import { findPlexShakaRuntime, type PlexShakaRuntime } from './native-hook.js';

interface WebpackRuntimeRequire {
  (moduleId: string): unknown;
  readonly m?: Record<string, (...args: unknown[]) => unknown>;
}

interface WebpackChunkArray extends Array<unknown> {
  push(...items: unknown[]): number;
}

interface WatchedChunkArray {
  readonly chunks: WebpackChunkArray;
  readonly originalPush: WebpackChunkArray['push'];
  readonly wrappedPush: WebpackChunkArray['push'];
  moduleCount: number;
}

export interface PlexShakaRuntimeWatcherOptions {
  host: Record<string, unknown>;
  /** 首次观察到 Plex 私有 webpack runtime 时触发，可作为站点身份与 watcher 就绪证据。 */
  onObserved?(): void;
  onRuntime(runtime: PlexShakaRuntime): void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  discoveryIntervalMs?: number;
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 250;

/**
 * PlexShakaRuntimeWatcher 持续观察 Plex 的 webpack 动态 chunk。
 * Shaka 可能直到首次播放才加载，因此发现器在成功安装 Hook 前不设固定截止时间。
 */
export class PlexShakaRuntimeWatcher {
  private readonly options: PlexShakaRuntimeWatcherOptions;
  private readonly schedule: NonNullable<PlexShakaRuntimeWatcherOptions['schedule']>;
  private readonly cancelSchedule: NonNullable<PlexShakaRuntimeWatcherOptions['cancelSchedule']>;
  private readonly discoveryIntervalMs: number;
  private readonly watched = new Map<string, WatchedChunkArray>();
  private readonly probing = new WeakSet<WebpackChunkArray>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private observed = false;

  constructor(options: PlexShakaRuntimeWatcherOptions) {
    this.options = options;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.discover();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = undefined;
    for (const watch of this.watched.values()) {
      if (watch.chunks.push === watch.wrappedPush) watch.chunks.push = watch.originalPush;
    }
    this.watched.clear();
  }

  private discover(): void {
    if (!this.running) return;
    for (const name of Object.keys(this.options.host)) {
      if (!name.startsWith('webpackChunk') || !name.toLowerCase().includes('plex')) continue;
      const value = this.options.host[name];
      if (!Array.isArray(value) || value.push === Array.prototype.push) continue;
      this.observe(name, value as WebpackChunkArray);
      if (!this.running) return;
    }
    // 已挂接 webpack chunk push 后由真实模块加载触发检查，不再轮询页面全局对象。
    if (this.watched.size > 0) return;
    this.timer = this.schedule(() => this.discover(), this.discoveryIntervalMs);
  }

  private observe(name: string, chunks: WebpackChunkArray): void {
    const current = this.watched.get(name);
    if (current?.chunks === chunks && current.wrappedPush === chunks.push) return;

    const originalPush = chunks.push;
    const watcher = this;
    const wrappedPush: WebpackChunkArray['push'] = function (
      this: WebpackChunkArray,
      ...items: unknown[]
    ): number {
      const result = Reflect.apply(originalPush, this, items) as number;
      if (!watcher.probing.has(chunks)) watcher.inspect(name);
      return result;
    };
    this.watched.set(name, { chunks, originalPush, wrappedPush, moduleCount: -1 });
    chunks.push = wrappedPush;
    if (!this.observed) {
      this.observed = true;
      this.options.onObserved?.();
    }
    this.inspect(name);
  }

  private inspect(name: string): void {
    if (!this.running) return;
    const watch = this.watched.get(name);
    if (!watch) return;
    let runtimeRequire: WebpackRuntimeRequire | undefined;
    this.probing.add(watch.chunks);
    try {
      watch.chunks.push([
        [`shimweave-native-${Date.now()}-${Math.random().toString(36).slice(2)}`],
        {},
        (value: WebpackRuntimeRequire) => {
          runtimeRequire = value;
        },
      ]);
    } catch {
      return;
    } finally {
      this.probing.delete(watch.chunks);
    }
    if (!runtimeRequire) return;
    const moduleCount = Object.keys(runtimeRequire.m ?? {}).length;
    if (moduleCount === watch.moduleCount) return;
    watch.moduleCount = moduleCount;
    const runtime = findPlexShakaRuntime(runtimeRequire);
    if (!runtime) return;
    this.options.onRuntime(runtime);
    this.stop();
  }
}
