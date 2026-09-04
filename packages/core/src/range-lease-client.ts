import {
  RANGE_LEASE_PROTOCOL,
  type RangeLeaseHostMessage,
  type RangeLeaseRejectedMessage,
} from '@shimweave/contracts';
import type { RangeLeasePort } from './range-lease-port.js';
import {
  RangeQueueFullError,
  RangeScheduledTaskCancelledError,
  type RangeScheduledTaskState,
  type RangeScheduleOptions,
  RangeSchedulerClosedError,
  RangeTaskPreemptedError,
  type RangeTaskScheduler,
  type ScheduledRangeTask,
} from './range-scheduler.js';

interface ClientTask {
  taskId: string;
  sourceId: string;
  state: RangeScheduledTaskState;
  priority: number;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  leaseRevoked: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  requestSent: boolean;
  requestTimer?: ReturnType<typeof setTimeout>;
  executionTimer?: ReturnType<typeof setTimeout>;
  execution?: Promise<void>;
}

export interface RangeLeaseSchedulerClientOptions {
  /** SharedWorker 协议握手的最长等待时间。 */
  handshakeTimeoutMs?: number;
  /** 请求发出后等待执行槽的最长时间。 */
  requestTimeoutMs?: number;
  /** 已获租约后单次 Range I/O 的最长执行时间。 */
  executionTimeoutMs?: number;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 65_000;

/** RangeLeaseSchedulerClient 在本地执行 I/O，只通过端口申请和释放跨标签槽位。 */
export class RangeLeaseSchedulerClient implements RangeTaskScheduler {
  private readonly tasks = new Map<string, ClientTask>();
  private readonly executions = new Set<Promise<void>>();
  private readonly listener = (event: { readonly data: unknown }) => this.onMessage(event.data);
  private readonly requestTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly handshakePromise: Promise<void>;
  private resolveHandshake: () => void = () => undefined;
  private rejectHandshake: (error: unknown) => void = () => undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private ready = false;
  private closed = false;

  constructor(
    private readonly port: RangeLeasePort,
    options: RangeLeaseSchedulerClientOptions = {},
  ) {
    const handshakeTimeoutMs = timeoutInteger(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    );
    this.requestTimeoutMs = timeoutInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.executionTimeoutMs = timeoutInteger(
      options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      'executionTimeoutMs',
    );
    this.handshakePromise = new Promise<void>((resolve, reject) => {
      this.resolveHandshake = resolve;
      this.rejectHandshake = reject;
    });
    void this.handshakePromise.catch(() => undefined);
    port.addEventListener('message', this.listener);
    port.start?.();
    if (!safePost(port, { protocol: RANGE_LEASE_PROTOCOL, type: 'hello' })) {
      const error = new RangeLeasePortError();
      this.rejectHandshake(error);
      port.removeEventListener('message', this.listener);
      port.close?.();
      this.closed = true;
      throw error;
    }
    if (!this.ready) {
      this.handshakeTimer = setTimeout(
        () => this.fail(new RangeLeaseProtocolError('Range lease protocol handshake timed out')),
        handshakeTimeoutMs,
      );
    }
  }

  schedule<T>(
    options: RangeScheduleOptions,
    execute: (signal: AbortSignal) => Promise<T>,
  ): ScheduledRangeTask<T> {
    if (this.closed) throw new RangeLeaseClientClosedError();
    const sourceId = options.sourceId.trim();
    if (sourceId === '') throw new TypeError('sourceId must not be empty');
    if (!Number.isFinite(options.priority)) throw new RangeError('priority must be finite');

    let resolvePromise: (value: unknown) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task: ClientTask = {
      taskId: `${this.sequence}`,
      sourceId,
      state: 'queued',
      priority: options.priority,
      controller: new AbortController(),
      execute,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
      leaseRevoked: false,
      requestSent: false,
    };
    this.sequence += 1;
    const handle = new RangeLeaseTaskHandle<T>(
      task,
      (priority) => this.promote(task, priority),
      (reason) => this.cancel(task, reason),
    );

    const externalSignal = options.signal;
    if (externalSignal) {
      task.signal = externalSignal;
      task.abort = () => this.cancel(task, abortReason(externalSignal));
      externalSignal.addEventListener('abort', task.abort, { once: true });
      if (externalSignal.aborted) {
        this.rejectTask(task, abortReason(externalSignal));
        this.cleanupTask(task);
        return handle;
      }
    }

    this.tasks.set(task.taskId, task);
    if (this.ready) this.sendRequest(task);
    return handle;
  }

  private sendRequest(task: ClientTask): void {
    if (task.state !== 'queued' || task.requestSent) return;
    task.requestSent = true;
    task.requestTimer = setTimeout(
      () => this.cancel(task, new RangeLeaseRequestExpiredError()),
      this.requestTimeoutMs,
    );
    if (
      !safePost(this.port, {
        protocol: RANGE_LEASE_PROTOCOL,
        type: 'request',
        taskId: task.taskId,
        sourceId: task.sourceId,
        priority: task.priority,
      })
    ) {
      this.rejectAndCleanup(task, new RangeLeasePortError());
      return;
    }
  }

  dispose(reason: unknown = new RangeLeaseClientClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (!this.ready) this.rejectHandshake(reason);
    for (const task of [...this.tasks.values()]) this.cancel(task, reason);
    safePost(this.port, { protocol: RANGE_LEASE_PROTOCOL, type: 'disconnect' });
    this.port.removeEventListener('message', this.listener);
    this.port.close?.();
  }

  async close(reason?: unknown): Promise<void> {
    this.dispose(reason);
    await Promise.allSettled([...this.executions]);
  }

  whenReady(): Promise<void> {
    return this.handshakePromise;
  }

  private onMessage(value: unknown): void {
    if (!isHostMessage(value)) return;
    if (value.type === 'ready') {
      this.acceptHandshake();
      return;
    }
    const task = this.tasks.get(value.taskId);
    if (!task) {
      if (value.type === 'granted') this.release(value.taskId);
      return;
    }
    if (value.type === 'granted') {
      if (task.state !== 'queued') {
        this.release(task.taskId);
        return;
      }
      this.execute(task);
      return;
    }

    const error = rejectionError(value);
    task.leaseRevoked = true;
    task.controller.abort(error);
    const wasRunning = task.state === 'running';
    this.rejectTask(task, error);
    if (!wasRunning) this.cleanupTask(task);
  }

  private execute(task: ClientTask): void {
    if (task.requestTimer) clearTimeout(task.requestTimer);
    task.state = 'running';
    task.executionTimer = setTimeout(
      () => this.cancel(task, new RangeLeaseExpiredError()),
      this.executionTimeoutMs,
    );
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
            this.rejectTask(task, abortReason(task.controller.signal));
          } else {
            this.resolveTask(task, value);
          }
        },
        (error: unknown) => this.rejectTask(task, error),
      )
      .finally(() => {
        if (!task.leaseRevoked) this.release(task.taskId);
        this.cleanupTask(task);
        this.executions.delete(execution);
      });
    task.execution = execution;
    this.executions.add(execution);
  }

  private promote(task: ClientTask, priority: number): void {
    if (task.state !== 'queued') return;
    if (!Number.isFinite(priority)) throw new RangeError('priority must be finite');
    if (priority >= task.priority) return;
    task.priority = priority;
    if (!task.requestSent) return;
    safePost(this.port, {
      protocol: RANGE_LEASE_PROTOCOL,
      type: 'promote',
      taskId: task.taskId,
      priority,
    });
  }

  private cancel(task: ClientTask, reason: unknown = new RangeScheduledTaskCancelledError()): void {
    if (task.state === 'settled') return;
    const wasQueued = task.state === 'queued';
    task.controller.abort(reason);
    this.rejectTask(task, reason);
    if (task.requestSent) {
      task.leaseRevoked = true;
      safePost(this.port, {
        protocol: RANGE_LEASE_PROTOCOL,
        type: 'cancel',
        taskId: task.taskId,
      });
    }
    if (wasQueued) this.cleanupTask(task);
  }

  private resolveTask(task: ClientTask, value: unknown): void {
    if (task.settled) return;
    task.settled = true;
    task.state = 'settled';
    task.resolve(value);
  }

  private rejectTask(task: ClientTask, error: unknown): void {
    if (task.settled) return;
    task.settled = true;
    task.state = 'settled';
    task.reject(error);
  }

  private rejectAndCleanup(task: ClientTask, error: unknown): void {
    this.rejectTask(task, error);
    this.cleanupTask(task);
  }

  private cleanupTask(task: ClientTask): void {
    if (task.requestTimer) clearTimeout(task.requestTimer);
    if (task.executionTimer) clearTimeout(task.executionTimer);
    if (task.signal && task.abort) task.signal.removeEventListener('abort', task.abort);
    if (this.tasks.get(task.taskId) === task) this.tasks.delete(task.taskId);
  }

  private release(taskId: string): void {
    safePost(this.port, {
      protocol: RANGE_LEASE_PROTOCOL,
      type: 'release',
      taskId,
    });
  }

  private acceptHandshake(): void {
    if (this.closed || this.ready) return;
    this.ready = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.resolveHandshake();
    for (const task of this.tasks.values()) this.sendRequest(task);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.rejectHandshake(error);
    for (const task of [...this.tasks.values()]) this.rejectAndCleanup(task, error);
    this.port.removeEventListener('message', this.listener);
    this.port.close?.();
  }
}

class RangeLeaseTaskHandle<T> implements ScheduledRangeTask<T> {
  readonly promise: Promise<T>;

  constructor(
    private readonly task: ClientTask,
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

export class RangeLeaseClientClosedError extends Error {
  constructor() {
    super('Range lease scheduler client is closed');
    this.name = 'RangeLeaseClientClosedError';
  }
}

export class RangeLeasePortError extends Error {
  constructor() {
    super('Range lease coordinator port is unavailable');
    this.name = 'RangeLeasePortError';
  }
}

export class RangeLeaseExpiredError extends Error {
  constructor() {
    super('Range lease expired before the task completed');
    this.name = 'RangeLeaseExpiredError';
  }
}

export class RangeLeaseRequestExpiredError extends Error {
  constructor() {
    super('Range lease request expired before a slot became available');
    this.name = 'RangeLeaseRequestExpiredError';
  }
}

const rejectionError = (message: RangeLeaseRejectedMessage): Error => {
  if (message.code === 'queue_full') return new RangeQueueFullError(message.limit ?? 0);
  if (message.code === 'preempted') {
    return new RangeTaskPreemptedError(
      message.taskPriority ?? Number.NaN,
      message.incomingPriority ?? Number.NaN,
    );
  }
  if (message.code === 'request_expired') return new RangeLeaseRequestExpiredError();
  if (message.code === 'lease_expired') return new RangeLeaseExpiredError();
  if (message.code === 'coordinator_closed') return new RangeSchedulerClosedError();
  if (message.code === 'invalid_request') return new RangeLeaseProtocolError();
  return new RangeScheduledTaskCancelledError();
};

export class RangeLeaseProtocolError extends Error {
  constructor(message = 'Range lease coordinator rejected an invalid request') {
    super(message);
    this.name = 'RangeLeaseProtocolError';
  }
}

const isHostMessage = (value: unknown): value is RangeLeaseHostMessage => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('protocol' in value) ||
    value.protocol !== RANGE_LEASE_PROTOCOL ||
    !('type' in value)
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (value.type === 'ready') return hasExactKeys(candidate, ['protocol', 'type']);
  if (typeof candidate.taskId !== 'string' || candidate.taskId === '') {
    return false;
  }
  if (value.type === 'granted') {
    return hasExactKeys(candidate, ['protocol', 'type', 'taskId']);
  }
  if (value.type !== 'rejected' || !isRejectionCode(candidate.code)) {
    return false;
  }
  const allowed: string[] = ['protocol', 'type', 'taskId', 'code'];
  for (const key of ['limit', 'taskPriority', 'incomingPriority'] as const) {
    if (key in candidate) {
      if (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key])) return false;
      allowed.push(key);
    }
  }
  return hasExactKeys(candidate, allowed);
};

const isRejectionCode = (value: unknown): value is RangeLeaseRejectedMessage['code'] =>
  value === 'queue_full' ||
  value === 'preempted' ||
  value === 'request_expired' ||
  value === 'lease_expired' ||
  value === 'coordinator_closed' ||
  value === 'invalid_request' ||
  value === 'cancelled';

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const safePost = (port: RangeLeasePort, message: unknown): boolean => {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const timeoutInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
};
