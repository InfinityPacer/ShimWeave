import {
  RANGE_LEASE_PROTOCOL,
  type RangeLeaseClientMessage,
  type RangeLeaseRejectedMessage,
} from '@shimweave/contracts';
import type { RangeLeasePort } from './range-lease-port.js';
import {
  RangeQueueFullError,
  RangeScheduler,
  RangeSchedulerClosedError,
  RangeTaskPreemptedError,
  type ScheduledRangeTask,
} from './range-scheduler.js';

export interface RangeLeaseCoordinatorOptions {
  scheduler?: RangeScheduler;
  /** 排队请求的最长等待时间；失联页面不能无限占用等待队列。 */
  requestTimeoutMs?: number;
  /** 租约失联后的自动回收时间；必须长于正常单次 Range 请求。 */
  leaseTimeoutMs?: number;
}

interface LeaseRecord {
  taskId: string;
  granted: boolean;
  notified: boolean;
  handle?: ScheduledRangeTask<void>;
  release?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

interface LeaseConnection {
  port: RangeLeasePort;
  records: Map<string, LeaseRecord>;
  listener: (event: { readonly data: unknown }) => void;
  ready: boolean;
  closed: boolean;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 60_000;

/** RangeLeaseCoordinator 在 SharedWorker 中仲裁执行槽，不接收 URL 或媒体数据。 */
export class RangeLeaseCoordinator {
  private readonly scheduler: RangeScheduler;
  private readonly ownsScheduler: boolean;
  private readonly requestTimeoutMs: number;
  private readonly leaseTimeoutMs: number;
  private readonly connections = new Set<LeaseConnection>();
  private closed = false;

  constructor(options: RangeLeaseCoordinatorOptions = {}) {
    this.scheduler = options.scheduler ?? new RangeScheduler();
    this.ownsScheduler = options.scheduler === undefined;
    this.requestTimeoutMs = timeoutInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.leaseTimeoutMs = timeoutInteger(
      options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS,
      'leaseTimeoutMs',
    );
  }

  attach(port: RangeLeasePort): () => void {
    if (this.closed) throw new RangeLeaseCoordinatorClosedError();
    const connection: LeaseConnection = {
      port,
      records: new Map(),
      listener: (event) => this.onMessage(connection, event.data),
      ready: false,
      closed: false,
    };
    this.connections.add(connection);
    port.addEventListener('message', connection.listener);
    port.start?.();
    return () => this.disconnect(connection, 'coordinator_closed');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.connections]) {
      this.disconnect(connection, 'coordinator_closed');
    }
    if (this.ownsScheduler) await this.scheduler.close();
  }

  private onMessage(connection: LeaseConnection, value: unknown): void {
    if (connection.closed || !isClientMessage(value)) return;
    if (value.type === 'hello') {
      connection.ready = true;
      safePost(connection.port, { protocol: RANGE_LEASE_PROTOCOL, type: 'ready' });
      return;
    }
    if (value.type === 'disconnect') {
      this.disconnect(connection);
      return;
    }
    if (!connection.ready) {
      this.postRejected(connection, value.taskId, 'invalid_request');
      return;
    }
    if (value.type === 'request') {
      this.request(connection, value.taskId, value.sourceId, value.priority);
      return;
    }

    const record = connection.records.get(value.taskId);
    if (!record) return;
    if (value.type === 'promote') {
      record.handle?.promote(value.priority);
    } else if (value.type === 'cancel') {
      record.notified = true;
      record.handle?.cancel(new RangeLeaseClientCancelledError());
    } else if (value.type === 'release') {
      record.release?.();
    }
  }

  private request(
    connection: LeaseConnection,
    taskId: string,
    sourceId: string,
    priority: number,
  ): void {
    if (connection.records.has(taskId)) {
      this.postRejected(connection, taskId, 'invalid_request');
      return;
    }
    const record: LeaseRecord = { taskId, granted: false, notified: false };
    connection.records.set(taskId, record);
    this.armTimeout(connection, record, this.requestTimeoutMs, 'request_expired');
    try {
      record.handle = this.scheduler.schedule({ sourceId, priority }, (signal) =>
        this.grant(connection, record, signal),
      );
      void record.handle.promise.then(
        () => this.cleanupRecord(connection, record),
        (error: unknown) => {
          if (!record.notified && !connection.closed) {
            this.postRejectedError(connection, record, error);
          }
          this.cleanupRecord(connection, record);
        },
      );
    } catch (error) {
      this.postRejectedError(connection, record, error);
      this.cleanupRecord(connection, record);
    }
  }

  private grant(
    connection: LeaseConnection,
    record: LeaseRecord,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      record.signal = signal;
      record.release = resolve;
      record.abort = () => reject(abortReason(signal));
      signal.addEventListener('abort', record.abort, { once: true });
      record.granted = true;
      this.armTimeout(connection, record, this.leaseTimeoutMs, 'lease_expired');
      if (
        !safePost(connection.port, {
          protocol: RANGE_LEASE_PROTOCOL,
          type: 'granted',
          taskId: record.taskId,
        })
      ) {
        reject(new RangeLeasePortUnavailableError());
      }
    });
  }

  private armTimeout(
    connection: LeaseConnection,
    record: LeaseRecord,
    timeoutMs: number,
    code: 'request_expired' | 'lease_expired',
  ): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      if (record.notified || connection.closed) return;
      record.notified = true;
      this.postRejected(connection, record.taskId, code);
      const error =
        code === 'lease_expired'
          ? new RangeLeaseExpiredError()
          : new RangeLeaseRequestExpiredError();
      record.handle?.cancel(error);
    }, timeoutMs);
  }

  private postRejectedError(
    connection: LeaseConnection,
    record: LeaseRecord,
    error: unknown,
  ): void {
    if (error instanceof RangeQueueFullError) {
      this.postRejected(connection, record.taskId, 'queue_full', { limit: error.limit });
    } else if (error instanceof RangeTaskPreemptedError) {
      this.postRejected(connection, record.taskId, 'preempted', {
        taskPriority: error.taskPriority,
        incomingPriority: error.incomingPriority,
      });
    } else if (
      error instanceof RangeSchedulerClosedError ||
      error instanceof RangeLeaseCoordinatorClosedError
    ) {
      this.postRejected(connection, record.taskId, 'coordinator_closed');
    } else if (error instanceof RangeLeaseExpiredError) {
      this.postRejected(connection, record.taskId, 'lease_expired');
    } else if (error instanceof RangeLeaseRequestExpiredError) {
      this.postRejected(connection, record.taskId, 'request_expired');
    } else {
      this.postRejected(connection, record.taskId, 'cancelled');
    }
  }

  private postRejected(
    connection: LeaseConnection,
    taskId: string,
    code: RangeLeaseRejectedMessage['code'],
    details: Pick<RangeLeaseRejectedMessage, 'limit' | 'taskPriority' | 'incomingPriority'> = {},
  ): void {
    safePost(connection.port, {
      protocol: RANGE_LEASE_PROTOCOL,
      type: 'rejected',
      taskId,
      code,
      ...details,
    });
  }

  private cleanupRecord(connection: LeaseConnection, record: LeaseRecord): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.signal && record.abort) {
      record.signal.removeEventListener('abort', record.abort);
    }
    if (connection.records.get(record.taskId) === record) {
      connection.records.delete(record.taskId);
    }
  }

  private disconnect(
    connection: LeaseConnection,
    rejectionCode?: RangeLeaseRejectedMessage['code'],
  ): void {
    if (connection.closed) return;
    if (rejectionCode) {
      for (const record of connection.records.values()) {
        if (record.notified) continue;
        record.notified = true;
        this.postRejected(connection, record.taskId, rejectionCode);
      }
    }
    connection.closed = true;
    connection.port.removeEventListener('message', connection.listener);
    for (const record of connection.records.values()) {
      record.handle?.cancel(new RangeLeasePortUnavailableError());
      this.cleanupRecord(connection, record);
    }
    connection.records.clear();
    this.connections.delete(connection);
    connection.port.close?.();
  }
}

export class RangeLeaseCoordinatorClosedError extends Error {
  constructor() {
    super('Range lease coordinator is closed');
    this.name = 'RangeLeaseCoordinatorClosedError';
  }
}

class RangeLeaseClientCancelledError extends Error {}
class RangeLeasePortUnavailableError extends Error {}
class RangeLeaseExpiredError extends Error {}
class RangeLeaseRequestExpiredError extends Error {}

const isClientMessage = (value: unknown): value is RangeLeaseClientMessage => {
  if (
    !isRecord(value) ||
    value.protocol !== RANGE_LEASE_PROTOCOL ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  if (value.type === 'hello' || value.type === 'disconnect') {
    return hasExactKeys(value, ['protocol', 'type']);
  }
  if (typeof value.taskId !== 'string' || value.taskId === '') return false;
  if (value.type === 'cancel' || value.type === 'release') {
    return hasExactKeys(value, ['protocol', 'type', 'taskId']);
  }
  if (value.type === 'promote') {
    return (
      hasExactKeys(value, ['protocol', 'type', 'taskId', 'priority']) &&
      Number.isFinite(value.priority)
    );
  }
  return (
    value.type === 'request' &&
    hasExactKeys(value, ['protocol', 'type', 'taskId', 'sourceId', 'priority']) &&
    typeof value.sourceId === 'string' &&
    value.sourceId.trim() !== '' &&
    Number.isFinite(value.priority)
  );
};

const safePost = (port: RangeLeasePort, message: unknown): boolean => {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const timeoutInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
};
