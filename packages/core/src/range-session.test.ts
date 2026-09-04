import type { ByteRange, ByteSource } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { RangeBrokerClosedError } from './range-broker.js';
import { RangeScheduler } from './range-scheduler.js';
import { RangeSession, RangeSessionClosedError } from './range-session.js';

interface PendingRead {
  signal: AbortSignal | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
}

class SessionSource implements ByteSource {
  readonly pending: PendingRead[] = [];
  closeCalls = 0;

  constructor(readonly sourceId: string) {}

  getSize(): Promise<number> {
    return Promise.resolve(16);
  }

  read(_range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.pending.push({ signal, resolve, reject });
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  close(): void {
    this.closeCalls += 1;
  }
}

describe('RangeSession', () => {
  it('快速切换会取消旧会话并立即把全局槽交给新会话', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxConcurrencyPerSource: 1 });
    const oldSource = new SessionSource('old-media');
    const nextSource = new SessionSource('next-media');
    const oldSession = new RangeSession({ scheduler });
    const nextSession = new RangeSession({ scheduler });
    const oldRead = oldSession.createBroker(oldSource).read({ start: 0, end: 1 });
    const nextRead = nextSession.createBroker(nextSource).read({ start: 0, end: 1 });

    expect(oldSource.pending).toHaveLength(1);
    expect(nextSource.pending).toHaveLength(0);
    const closing = oldSession.close(new Error('media switched'));
    await expect(oldRead).rejects.toBeInstanceOf(RangeBrokerClosedError);
    await closing;
    await Promise.resolve();

    expect(oldSource.pending[0]?.signal?.aborted).toBe(true);
    expect(nextSource.pending).toHaveLength(1);
    nextSource.pending[0]?.resolve(Uint8Array.from([1]));
    await expect(nextRead).resolves.toEqual(Uint8Array.from([1]));
    await nextSession.close();
    await scheduler.close();
  });

  it('关闭一个会话会释放其全部媒体源但不关闭共享调度器', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 2 });
    const first = new SessionSource('first');
    const second = new SessionSource('second');
    const session = new RangeSession({ scheduler });
    const firstRead = session.createBroker(first).read({ start: 0, end: 1 });
    const secondRead = session.createBroker(second).read({ start: 0, end: 1 });

    await session.close();
    await expect(firstRead).rejects.toBeInstanceOf(RangeBrokerClosedError);
    await expect(secondRead).rejects.toBeInstanceOf(RangeBrokerClosedError);
    expect(session.signal.aborted).toBe(true);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);

    const surviving = new RangeSession({ scheduler });
    const third = new SessionSource('third');
    const thirdRead = surviving.createBroker(third).read({ start: 0, end: 1 });
    third.pending[0]?.resolve(Uint8Array.from([2]));
    await expect(thirdRead).resolves.toEqual(Uint8Array.from([2]));
    await surviving.close();
    await scheduler.close();
  });

  it('关闭后禁止再创建媒体源且重复关闭保持幂等', async () => {
    const scheduler = new RangeScheduler();
    const session = new RangeSession({ scheduler });
    const firstClose = session.close();
    const secondClose = session.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(() => session.createBroker(new SessionSource('late'))).toThrow(RangeSessionClosedError);
    await scheduler.close();
  });
});
