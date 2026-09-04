import { RANGE_LEASE_PROTOCOL } from '@shimweave/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RangeLeaseExpiredError,
  RangeLeaseProtocolError,
  RangeLeaseRequestExpiredError,
  RangeLeaseSchedulerClient,
} from './range-lease-client.js';
import { RangeLeaseCoordinator } from './range-lease-coordinator.js';
import type { RangeLeaseMessageEvent, RangeLeasePort } from './range-lease-port.js';
import {
  RangeScheduler,
  RangeSchedulerClosedError,
  RangeTaskPreemptedError,
} from './range-scheduler.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class TestPort implements RangeLeasePort {
  readonly sent: unknown[] = [];
  peer?: TestPort;
  closed = false;

  private readonly listeners = new Set<(event: RangeLeaseMessageEvent) => void>();

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('port closed');
    const cloned = structuredClone(message);
    this.sent.push(cloned);
    queueMicrotask(() => this.peer?.dispatch(cloned));
  }

  addEventListener(_type: 'message', listener: (event: RangeLeaseMessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: RangeLeaseMessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private dispatch(data: unknown): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener({ data });
  }
}

const createPortPair = (): [TestPort, TestPort] => {
  const left = new TestPort();
  const right = new TestPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
};

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const flushMessages = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const connectClient = (
  coordinator: RangeLeaseCoordinator,
  options: ConstructorParameters<typeof RangeLeaseSchedulerClient>[1] = {},
): { client: RangeLeaseSchedulerClient; clientPort: TestPort; detach: () => void } => {
  const [hostPort, clientPort] = createPortPair();
  const detach = coordinator.attach(hostPort);
  const client = new RangeLeaseSchedulerClient(clientPort, options);
  return { client, clientPort, detach };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Range Lease 跨端口调度', () => {
  it('在两个客户端之间共享全局槽位，但实际 I/O 留在各自客户端', async () => {
    const scheduler = new RangeScheduler({
      maxConcurrency: 1,
      maxConcurrencyPerSource: 1,
      maxQueued: 4,
    });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const first = connectClient(coordinator);
    const second = connectClient(coordinator);
    await flushMessages();

    const firstIO = deferred<string>();
    const secondIO = deferred<string>();
    const started: string[] = [];
    const firstTask = first.client.schedule({ sourceId: 'media-a', priority: 10 }, async () => {
      started.push('first');
      return firstIO.promise;
    });
    const secondTask = second.client.schedule({ sourceId: 'media-b', priority: 10 }, async () => {
      started.push('second');
      return secondIO.promise;
    });

    await flushMessages();
    expect(started).toEqual(['first']);
    firstIO.resolve('a');
    await expect(firstTask.promise).resolves.toBe('a');
    await flushMessages();
    expect(started).toEqual(['first', 'second']);
    secondIO.resolve('b');
    await expect(secondTask.promise).resolves.toBe('b');

    await Promise.all([first.client.close(), second.client.close()]);
    await coordinator.close();
    await scheduler.close();
  });

  it('允许不同端口复用本地 taskId 而不串租约', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 2, maxConcurrencyPerSource: 2 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const first = connectClient(coordinator);
    const second = connectClient(coordinator);
    await flushMessages();

    const taskA = first.client.schedule({ sourceId: 'media-a', priority: 10 }, async () => 'a');
    const taskB = second.client.schedule({ sourceId: 'media-b', priority: 10 }, async () => 'b');

    await expect(Promise.all([taskA.promise, taskB.promise])).resolves.toEqual(['a', 'b']);
    expect(first.clientPort.sent).toContainEqual(
      expect.objectContaining({ type: 'request', taskId: '0', sourceId: 'media-a' }),
    );
    expect(second.clientPort.sent).toContainEqual(
      expect.objectContaining({ type: 'request', taskId: '0', sourceId: 'media-b' }),
    );

    await Promise.all([first.client.close(), second.client.close()]);
    await coordinator.close();
    await scheduler.close();
  });

  it('取消排队任务后立即从客户端和 Coordinator 清理', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 4 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const connection = connectClient(coordinator);
    await flushMessages();

    const activeIO = deferred<string>();
    let queuedStarted = false;
    const active = connection.client.schedule(
      { sourceId: 'media-a', priority: 10 },
      async () => activeIO.promise,
    );
    const queued = connection.client.schedule({ sourceId: 'media-b', priority: 10 }, async () => {
      queuedStarted = true;
      return 'queued';
    });
    await flushMessages();

    const reason = new Error('session switched');
    queued.cancel(reason);
    await expect(queued.promise).rejects.toBe(reason);
    await flushMessages();
    expect(scheduler.stats().queued).toBe(0);

    activeIO.resolve('active');
    await expect(active.promise).resolves.toBe('active');
    await flushMessages();
    expect(queuedStarted).toBe(false);

    await connection.client.close();
    await coordinator.close();
    await scheduler.close();
  });

  it('运行中取消会立即归还 Host 槽位，即使旧执行稍后才结束', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 4 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const connection = connectClient(coordinator);
    await flushMessages();

    const stubbornIO = deferred<string>();
    const nextIO = deferred<string>();
    let nextStarted = false;
    const stubborn = connection.client.schedule(
      { sourceId: 'media-a', priority: 10 },
      async () => stubbornIO.promise,
    );
    const next = connection.client.schedule({ sourceId: 'media-b', priority: 10 }, async () => {
      nextStarted = true;
      return nextIO.promise;
    });
    await flushMessages();

    const reason = new Error('seek replaced the old read');
    stubborn.cancel(reason);
    await expect(stubborn.promise).rejects.toBe(reason);
    await flushMessages();
    expect(nextStarted).toBe(true);

    nextIO.resolve('next');
    stubbornIO.resolve('late');
    await expect(next.promise).resolves.toBe('next');
    await connection.client.close();
    await coordinator.close();
    await scheduler.close();
  });

  it('高优先级端口请求可淘汰另一个端口的低优先级等待项', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 1 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const first = connectClient(coordinator);
    const second = connectClient(coordinator);
    await flushMessages();

    const activeIO = deferred<string>();
    const highIO = deferred<string>();
    const active = first.client.schedule(
      { sourceId: 'active', priority: 10 },
      async () => activeIO.promise,
    );
    const low = first.client.schedule({ sourceId: 'low', priority: 30 }, async () => 'low');
    const high = second.client.schedule(
      { sourceId: 'high', priority: 0 },
      async () => highIO.promise,
    );
    await expect(low.promise).rejects.toBeInstanceOf(RangeTaskPreemptedError);

    activeIO.resolve('active');
    await expect(active.promise).resolves.toBe('active');
    await flushMessages();
    highIO.resolve('high');
    await expect(high.promise).resolves.toBe('high');
    expect(scheduler.stats().preemptions).toBe(1);

    await Promise.all([first.client.close(), second.client.close()]);
    await coordinator.close();
    await scheduler.close();
  });

  it('排队任务提升优先级后按新顺序取得槽位', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 4 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const first = connectClient(coordinator);
    const second = connectClient(coordinator);
    await flushMessages();

    const activeIO = deferred<string>();
    const promotedIO = deferred<string>();
    const ordinaryIO = deferred<string>();
    const started: string[] = [];
    const active = first.client.schedule(
      { sourceId: 'active', priority: 10 },
      async () => activeIO.promise,
    );
    const promoted = first.client.schedule({ sourceId: 'promoted', priority: 20 }, async () => {
      started.push('promoted');
      return promotedIO.promise;
    });
    const ordinary = second.client.schedule({ sourceId: 'ordinary', priority: 10 }, async () => {
      started.push('ordinary');
      return ordinaryIO.promise;
    });
    await flushMessages();
    promoted.promote(0);
    await flushMessages();

    activeIO.resolve('active');
    await expect(active.promise).resolves.toBe('active');
    await flushMessages();
    expect(started).toEqual(['promoted']);

    promotedIO.resolve('promoted');
    await expect(promoted.promise).resolves.toBe('promoted');
    await flushMessages();
    ordinaryIO.resolve('ordinary');
    await expect(ordinary.promise).resolves.toBe('ordinary');

    await Promise.all([first.client.close(), second.client.close()]);
    await coordinator.close();
    await scheduler.close();
  });

  it('兼容浏览器原生 MessageChannel 的消息顺序和关闭语义', async () => {
    const coordinator = new RangeLeaseCoordinator();
    const channel = new MessageChannel();
    coordinator.attach(channel.port1);
    const client = new RangeLeaseSchedulerClient(channel.port2);
    const task = client.schedule({ sourceId: 'native-channel', priority: 10 }, async () => 'ok');

    await expect(task.promise).resolves.toBe('ok');
    await client.close();
    await coordinator.close();
  });
});

describe('Range Lease 失联与超时', () => {
  it('协议握手失败时有界结束，不让任务永久等待', async () => {
    vi.useFakeTimers();
    const [, clientPort] = createPortPair();
    const client = new RangeLeaseSchedulerClient(clientPort, { handshakeTimeoutMs: 10 });
    const task = client.schedule({ sourceId: 'media', priority: 10 }, async () => 'never');
    const rejected = expect(task.promise).rejects.toBeInstanceOf(RangeLeaseProtocolError);

    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(task.state).toBe('settled');
  });

  it('失联排队请求到期后不会在未来获得槽位', async () => {
    vi.useFakeTimers();
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 4 });
    const coordinator = new RangeLeaseCoordinator({
      scheduler,
      requestTimeoutMs: 10,
      leaseTimeoutMs: 1_000,
    });
    const connection = connectClient(coordinator, {
      requestTimeoutMs: 20,
      executionTimeoutMs: 1_100,
    });
    await flushMessages();

    const activeIO = deferred<string>();
    const active = connection.client.schedule(
      { sourceId: 'media-a', priority: 10 },
      async () => activeIO.promise,
    );
    const expired = connection.client.schedule(
      { sourceId: 'media-b', priority: 10 },
      async () => 'never',
    );
    const rejected = expect(expired.promise).rejects.toBeInstanceOf(RangeLeaseRequestExpiredError);
    await flushMessages();

    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(scheduler.stats().queued).toBe(0);

    activeIO.resolve('active');
    await expect(active.promise).resolves.toBe('active');
    await connection.client.close();
    await coordinator.close();
    await scheduler.close();
  });

  it('运行租约到期会中止本地 I/O 并释放下一个请求', async () => {
    vi.useFakeTimers();
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 4 });
    const coordinator = new RangeLeaseCoordinator({
      scheduler,
      requestTimeoutMs: 1_000,
      leaseTimeoutMs: 10,
    });
    const connection = connectClient(coordinator, {
      requestTimeoutMs: 1_100,
      executionTimeoutMs: 20,
    });
    await flushMessages();

    let firstSignal: AbortSignal | undefined;
    let secondStarted = false;
    const first = connection.client.schedule({ sourceId: 'media-a', priority: 10 }, (signal) => {
      firstSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const second = connection.client.schedule({ sourceId: 'media-b', priority: 10 }, async () => {
      secondStarted = true;
      return 'second';
    });
    const rejected = expect(first.promise).rejects.toBeInstanceOf(RangeLeaseExpiredError);
    await flushMessages();

    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    await flushMessages();
    expect(firstSignal?.aborted).toBe(true);
    expect(secondStarted).toBe(true);
    await expect(second.promise).resolves.toBe('second');

    await connection.client.close();
    await coordinator.close();
    await scheduler.close();
  });

  it('Coordinator 主动关闭会先拒绝客户端任务', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const connection = connectClient(coordinator);
    await flushMessages();

    let signal: AbortSignal | undefined;
    const task = connection.client.schedule({ sourceId: 'media', priority: 10 }, (current) => {
      signal = current;
      return new Promise((_resolve, reject) => {
        current.addEventListener('abort', () => reject(current.reason), { once: true });
      });
    });
    await flushMessages();

    await coordinator.close();
    await flushMessages();
    await expect(task.promise).rejects.toBeInstanceOf(RangeSchedulerClosedError);
    expect(signal?.aborted).toBe(true);
    await connection.client.close();
    await scheduler.close();
  });

  it('拒绝携带额外媒体字段的协议消息', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const coordinator = new RangeLeaseCoordinator({ scheduler });
    const [hostPort, clientPort] = createPortPair();
    coordinator.attach(hostPort);
    clientPort.postMessage({ protocol: RANGE_LEASE_PROTOCOL, type: 'hello' });
    await flushMessages();

    clientPort.postMessage({
      protocol: RANGE_LEASE_PROTOCOL,
      type: 'request',
      taskId: 'media-bytes',
      sourceId: 'stable-id',
      priority: 10,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await flushMessages();
    expect(scheduler.stats()).toMatchObject({ active: 0, queued: 0 });

    clientPort.close();
    await coordinator.close();
    await scheduler.close();
  });
});
