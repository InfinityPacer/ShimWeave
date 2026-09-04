export interface SiteAdapterClientActivationOptions {
  /** 向后台证明当前文档 watcher 已就绪，并完成 adapter 与 DNR 激活。 */
  activate(): Promise<boolean>;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  /** 临时激活失败的有界退避序列；耗尽后等待后台恢复通知或页面重载。 */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/**
 * 页面侧只有在站点 Hook watcher 就绪后才请求后台启用 DNR。恢复通知会复用同一握手，且并发
 * 请求只保留一次执行，避免 Service Worker 重启或重复 hook-ready 造成规则更新风暴。
 */
export class SiteAdapterClientActivation {
  private watcherIsReady = false;
  private active = false;
  private stopped = false;
  private rerun = false;
  private inFlight: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private readonly scheduleRetryCallback: NonNullable<
    SiteAdapterClientActivationOptions['schedule']
  >;
  private readonly cancelRetryCallback: NonNullable<
    SiteAdapterClientActivationOptions['cancelSchedule']
  >;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly options: SiteAdapterClientActivationOptions) {
    this.scheduleRetryCallback =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelRetryCallback = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  watcherReady(): void {
    if (this.stopped) return;
    this.watcherIsReady = true;
    this.schedule();
  }

  reactivate(): void {
    if (this.stopped) return;
    this.active = false;
    this.retryAttempt = 0;
    this.clearRetry();
    if (this.inFlight) this.rerun = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.rerun = false;
    this.clearRetry();
  }

  private schedule(): void {
    if (this.stopped || !this.watcherIsReady || this.active || this.inFlight) return;
    this.inFlight = this.options
      .activate()
      .then((active) => {
        this.active = active;
      })
      .catch(() => {
        this.active = false;
      })
      .finally(() => {
        this.inFlight = undefined;
        if (this.stopped) return;
        if (this.active) {
          this.rerun = false;
          this.retryAttempt = 0;
          this.clearRetry();
          return;
        }
        if (this.rerun) {
          this.rerun = false;
          this.schedule();
          return;
        }
        this.scheduleRetry();
      });
  }

  private scheduleRetry(): void {
    const delayMs = this.retryDelaysMs[this.retryAttempt];
    if (delayMs === undefined || this.retryTimer || this.stopped) return;
    this.retryAttempt += 1;
    this.retryTimer = this.scheduleRetryCallback(() => {
      this.retryTimer = undefined;
      this.schedule();
    }, delayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) this.cancelRetryCallback(this.retryTimer);
    this.retryTimer = undefined;
  }
}
