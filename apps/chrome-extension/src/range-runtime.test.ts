import { RANGE_LEASE_PROTOCOL } from '@shimweave/contracts';
import type { RangeLeaseMessageEvent, RangeLeasePort } from '@shimweave/core';
import { RangeLeaseCoordinator } from '@shimweave/core';
import { describe, expect, it } from 'vitest';
import { createBrowserRangeScheduler } from './range-runtime.js';

class TestPort implements RangeLeasePort {
  peer?: TestPort;

  private readonly listeners = new Set<(event: RangeLeaseMessageEvent) => void>();

  postMessage(message: unknown): void {
    const cloned = structuredClone(message);
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
    this.listeners.clear();
  }

  private dispatch(data: unknown): void {
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

describe('Chrome Range 调度运行时', () => {
  it('握手成功后使用 SharedWorker 仲裁实际执行槽', async () => {
    const coordinator = new RangeLeaseCoordinator();
    const [hostPort, clientPort] = createPortPair();
    let receivedURL = '';
    let receivedName = '';
    const runtime = await createBrowserRangeScheduler({
      workerURL: 'chrome-extension://test/range-coordinator.js',
      createSharedWorker: (url, name) => {
        receivedURL = url;
        receivedName = name;
        coordinator.attach(hostPort);
        return { port: clientPort };
      },
    });

    expect(runtime.mode).toBe('shared');
    expect(receivedURL).toBe('chrome-extension://test/range-coordinator.js');
    expect(receivedName).toBe('shimweave-range-v1');
    const task = runtime.scheduler.schedule({ sourceId: 'media', priority: 10 }, async () => 'ok');
    await expect(task.promise).resolves.toBe('ok');

    await runtime.close();
    await coordinator.close();
  });

  it('SharedWorker 不可创建时降级为单页面调度器', async () => {
    const runtime = await createBrowserRangeScheduler({
      workerURL: 'chrome-extension://test/range-coordinator.js',
      createSharedWorker: () => {
        throw new Error('unsupported');
      },
    });

    expect(runtime).toMatchObject({
      mode: 'local',
      fallbackReason: 'shared-worker-handshake-failed',
    });
    const task = runtime.scheduler.schedule({ sourceId: 'media', priority: 10 }, async () => 'ok');
    await expect(task.promise).resolves.toBe('ok');
    await runtime.close();
  });

  it('错误协议不会永久挂起并安全降级', async () => {
    const [hostPort, clientPort] = createPortPair();
    hostPort.addEventListener('message', (event) => {
      if (typeof event.data !== 'object' || event.data === null) return;
      hostPort.postMessage({ protocol: `${RANGE_LEASE_PROTOCOL}-old`, type: 'ready' });
    });
    const runtimePromise = createBrowserRangeScheduler({
      workerURL: 'chrome-extension://test/range-coordinator.js',
      createSharedWorker: () => ({ port: clientPort }),
      leaseClient: { handshakeTimeoutMs: 5 },
    });

    await expect(runtimePromise).resolves.toMatchObject({
      mode: 'local',
      fallbackReason: 'shared-worker-handshake-failed',
    });
    const runtime = await runtimePromise;
    await runtime.close();
  });
});
