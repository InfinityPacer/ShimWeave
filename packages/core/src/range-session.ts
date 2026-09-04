import type { ByteSource } from '@shimweave/contracts';
import { RangeBroker, type RangeBrokerOptions } from './range-broker.js';
import type { RangeTaskScheduler } from './range-scheduler.js';

export type RangeSessionBrokerOptions = Omit<RangeBrokerOptions, 'scheduler'>;

export interface RangeSessionOptions {
  /** 所有活动播放会话必须共享同一个运行时调度器。 */
  scheduler: RangeTaskScheduler;
  /** 会话创建的每个 Broker 共用的缓存默认值。 */
  brokerDefaults?: RangeSessionBrokerOptions;
}

/**
 * RangeSession 绑定一次播放意图的所有媒体源；关闭时同步广播取消，再等待资源释放完成。
 */
export class RangeSession {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly scheduler: RangeTaskScheduler;
  private readonly brokerDefaults: RangeSessionBrokerOptions;
  private readonly brokers = new Set<RangeBroker>();
  private closePromise: Promise<void> | undefined;

  constructor(options: RangeSessionOptions) {
    this.scheduler = options.scheduler;
    this.brokerDefaults = options.brokerDefaults ?? {};
    this.signal = this.controller.signal;
  }

  createBroker(source: ByteSource, options: RangeSessionBrokerOptions = {}): RangeBroker {
    this.assertOpen();
    const broker = new RangeBroker(source, {
      ...this.brokerDefaults,
      ...options,
      scheduler: this.scheduler,
    });
    this.brokers.add(broker);
    return broker;
  }

  close(reason: unknown = new RangeSessionClosedError()): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.controller.abort(reason);
    const brokers = [...this.brokers];
    this.brokers.clear();
    this.closePromise = Promise.allSettled(brokers.map((broker) => broker.close())).then(
      (results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Range session resource cleanup failed');
        }
      },
    );
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.signal.aborted) throw new RangeSessionClosedError();
  }
}

/** RangeSessionClosedError 表示播放意图已结束或已被新媒体替换。 */
export class RangeSessionClosedError extends Error {
  constructor() {
    super('Range session is closed');
    this.name = 'RangeSessionClosedError';
  }
}
