export type RangeScheduledTaskState = 'queued' | 'running' | 'settled';

export interface RangeSchedulerOptions {
  /** 同一执行上下文访问所有媒体源的总并发上限。 */
  maxConcurrency?: number;
  /** 单一稳定 sourceId 的并发上限。 */
  maxConcurrencyPerSource?: number;
  /** 全局等待队列上限；不包含正在执行的任务。 */
  maxQueued?: number;
}

export interface RangeScheduleOptions {
  /** 稳定的不透明内容身份，用于执行单源并发约束。 */
  sourceId: string;
  /** 数值越小优先级越高。 */
  priority: number;
  /** 调用方生命周期信号；取消后不会影响其他任务。 */
  signal?: AbortSignal;
}

export interface RangeSchedulerStats {
  /** 当前实际执行远程 I/O 的任务数。 */
  active: number;
  /** 尚未取得执行槽的任务数。 */
  queued: number;
  /** 当前占用执行槽的不同 sourceId 数量。 */
  sources: number;
  /** 为高优先级任务淘汰等待任务的累计次数。 */
  preemptions: number;
}

/** ScheduledRangeTask 允许共享读取在入队后提升优先级或被所属会话取消。 */
export interface ScheduledRangeTask<T> {
  readonly promise: Promise<T>;
  readonly state: RangeScheduledTaskState;
  promote(priority: number): void;
  cancel(reason?: unknown): void;
}

/** RangeTaskScheduler 允许本地调度器与扩展 Host 租约客户端使用同一 Broker 契约。 */
export interface RangeTaskScheduler {
  schedule<T>(
    options: RangeScheduleOptions,
    execute: (signal: AbortSignal) => Promise<T>,
  ): ScheduledRangeTask<T>;
}

interface SchedulerTask {
  sourceId: string;
  priority: number;
  sequence: number;
  state: RangeScheduledTaskState;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_MAX_CONCURRENCY_PER_SOURCE = 2;
const DEFAULT_MAX_QUEUED = 256;

/** RangeScheduler 在一个浏览器运行时内统一管理跨媒体、跨会话的远程读取。 */
export class RangeScheduler implements RangeTaskScheduler {
  private readonly maxConcurrency: number;
  private readonly maxConcurrencyPerSource: number;
  private readonly maxQueued: number;
  private readonly queued: SchedulerTask[] = [];
  private readonly tasks = new Set<SchedulerTask>();
  private readonly executions = new Set<Promise<void>>();
  private readonly activeBySource = new Map<string, number>();
  private sequence = 0;
  private active = 0;
  private preemptions = 0;
  private closed = false;

  constructor(options: RangeSchedulerOptions = {}) {
    this.maxConcurrency = positiveInteger(
      options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      'maxConcurrency',
    );
    this.maxConcurrencyPerSource = positiveInteger(
      options.maxConcurrencyPerSource ?? DEFAULT_MAX_CONCURRENCY_PER_SOURCE,
      'maxConcurrencyPerSource',
    );
    this.maxQueued = nonNegativeInteger(options.maxQueued ?? DEFAULT_MAX_QUEUED, 'maxQueued');
  }

  schedule<T>(
    options: RangeScheduleOptions,
    execute: (signal: AbortSignal) => Promise<T>,
  ): ScheduledRangeTask<T> {
    this.assertOpen();
    const sourceId = options.sourceId.trim();
    if (sourceId === '') throw new TypeError('sourceId must not be empty');
    const priority = finiteNumber(options.priority, 'priority');
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');

    let resolvePromise: (value: unknown) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task: SchedulerTask = {
      sourceId,
      priority,
      sequence: this.sequence,
      state: 'queued',
      controller: new AbortController(),
      execute,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.sequence += 1;
    const handle = new ScheduledRangeTaskHandle<T>(
      task,
      (nextPriority) => this.promoteTask(task, nextPriority),
      (reason) => this.cancelTask(task, reason),
    );

    const externalSignal = options.signal;
    if (externalSignal) {
      task.signal = externalSignal;
      task.abort = () => this.cancelTask(task, abortReason(externalSignal));
      externalSignal.addEventListener('abort', task.abort, { once: true });
      if (externalSignal.aborted) {
        this.settleRejected(task, abortReason(externalSignal));
        return handle;
      }
    }

    if (!this.canRun(task) && this.queued.length >= this.maxQueued) {
      const displaced = this.findDisplaceableTask(priority);
      if (!displaced) {
        this.settleRejected(task, new RangeQueueFullError(this.maxQueued));
        return handle;
      }
      this.preemptions += 1;
      this.settleRejected(displaced, new RangeTaskPreemptedError(displaced.priority, priority));
    }

    this.tasks.add(task);
    this.queued.push(task);
    this.drain();
    return handle;
  }

  stats(): RangeSchedulerStats {
    return {
      active: this.active,
      queued: this.queued.length,
      sources: this.activeBySource.size,
      preemptions: this.preemptions,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new RangeSchedulerClosedError();
    for (const task of [...this.tasks]) this.cancelTask(task, error);
    await Promise.allSettled([...this.executions]);
  }

  private promoteTask(task: SchedulerTask, priority: number): void {
    if (task.state === 'settled') return;
    const nextPriority = finiteNumber(priority, 'priority');
    if (nextPriority >= task.priority) return;
    task.priority = nextPriority;
    if (task.state === 'queued') this.drain();
  }

  private cancelTask(
    task: SchedulerTask,
    reason: unknown = new RangeScheduledTaskCancelledError(),
  ): void {
    if (task.state === 'settled') return;
    task.controller.abort(reason);
    if (task.state === 'queued') {
      this.removeQueued(task);
      this.settleRejected(task, reason);
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const task = this.nextRunnableTask();
      if (!task) return;
      this.start(task);
    }
  }

  private start(task: SchedulerTask): void {
    task.state = 'running';
    this.active += 1;
    this.activeBySource.set(task.sourceId, (this.activeBySource.get(task.sourceId) ?? 0) + 1);

    let outcome: Promise<unknown>;
    try {
      outcome = task.execute(task.controller.signal);
    } catch (error) {
      outcome = Promise.reject(error);
    }
    const execution = Promise.resolve(outcome)
      .then(
        (value) => {
          if (task.controller.signal.aborted) {
            this.settleRejected(task, abortReason(task.controller.signal));
          } else {
            this.settleResolved(task, value);
          }
        },
        (error: unknown) => this.settleRejected(task, error),
      )
      .finally(() => {
        this.active -= 1;
        const sourceActive = (this.activeBySource.get(task.sourceId) ?? 1) - 1;
        if (sourceActive === 0) this.activeBySource.delete(task.sourceId);
        else this.activeBySource.set(task.sourceId, sourceActive);
        this.executions.delete(execution);
        this.drain();
      });
    this.executions.add(execution);
  }

  private nextRunnableTask(): SchedulerTask | undefined {
    this.queued.sort(
      (left, right) => left.priority - right.priority || left.sequence - right.sequence,
    );
    const index = this.queued.findIndex((task) => this.canRun(task));
    if (index < 0) return undefined;
    return this.queued.splice(index, 1)[0];
  }

  private canRun(task: SchedulerTask): boolean {
    return (
      this.active < this.maxConcurrency &&
      (this.activeBySource.get(task.sourceId) ?? 0) < this.maxConcurrencyPerSource
    );
  }

  private findDisplaceableTask(priority: number): SchedulerTask | undefined {
    let candidate: SchedulerTask | undefined;
    for (const task of this.queued) {
      if (task.priority <= priority) continue;
      if (
        !candidate ||
        task.priority > candidate.priority ||
        (task.priority === candidate.priority && task.sequence > candidate.sequence)
      ) {
        candidate = task;
      }
    }
    return candidate;
  }

  private settleResolved(task: SchedulerTask, value: unknown): void {
    if (task.state === 'settled') return;
    task.state = 'settled';
    this.detachSignal(task);
    this.tasks.delete(task);
    task.resolve(value);
  }

  private settleRejected(task: SchedulerTask, error: unknown): void {
    if (task.state === 'settled') return;
    if (task.state === 'queued') this.removeQueued(task);
    task.state = 'settled';
    this.detachSignal(task);
    this.tasks.delete(task);
    task.reject(error);
  }

  private removeQueued(task: SchedulerTask): void {
    const index = this.queued.indexOf(task);
    if (index >= 0) this.queued.splice(index, 1);
  }

  private detachSignal(task: SchedulerTask): void {
    if (task.signal && task.abort) task.signal.removeEventListener('abort', task.abort);
  }

  private assertOpen(): void {
    if (this.closed) throw new RangeSchedulerClosedError();
  }
}

class ScheduledRangeTaskHandle<T> implements ScheduledRangeTask<T> {
  readonly promise: Promise<T>;

  constructor(
    private readonly task: SchedulerTask,
    private readonly promoteTask: (priority: number) => void,
    private readonly cancelTask: (reason?: unknown) => void,
  ) {
    this.promise = task.promise as Promise<T>;
  }

  get state(): RangeScheduledTaskState {
    return this.task.state;
  }

  promote(priority: number): void {
    this.promoteTask(priority);
  }

  cancel(reason?: unknown): void {
    this.cancelTask(reason);
  }
}

/** RangeQueueFullError 表示全局队列中没有可淘汰的低优先级任务。 */
export class RangeQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Range queue limit ${limit} reached`);
    this.name = 'RangeQueueFullError';
  }
}

/** RangeTaskPreemptedError 表示等待任务为更高优先级读取让出队列。 */
export class RangeTaskPreemptedError extends Error {
  constructor(
    readonly taskPriority: number,
    readonly incomingPriority: number,
  ) {
    super(`Range task priority ${taskPriority} was preempted by priority ${incomingPriority}`);
    this.name = 'RangeTaskPreemptedError';
  }
}

/** RangeScheduledTaskCancelledError 表示调用方主动撤销尚未完成的读取。 */
export class RangeScheduledTaskCancelledError extends Error {
  constructor() {
    super('Range task was cancelled');
    this.name = 'RangeScheduledTaskCancelledError';
  }
}

/** RangeSchedulerClosedError 表示整个浏览器运行时正在释放。 */
export class RangeSchedulerClosedError extends Error {
  constructor() {
    super('Range scheduler is closed');
    this.name = 'RangeSchedulerClosedError';
  }
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};

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

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
