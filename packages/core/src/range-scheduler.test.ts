import { describe, expect, it } from 'vitest';
import {
  RangeQueueFullError,
  RangeScheduler,
  RangeSchedulerClosedError,
  RangeTaskPreemptedError,
} from './range-scheduler.js';

interface PendingTask {
  name: string;
  signal: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

const controlledExecutor = (pending: PendingTask[], name: string) => (signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    pending.push({ name, signal, resolve, reject });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('RangeScheduler', () => {
  it('同时限制全局并发和单源并发，并允许其他媒体使用空闲槽', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({
      maxConcurrency: 3,
      maxConcurrencyPerSource: 1,
    });

    const a1 = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'a1'),
    );
    const a2 = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'a2'),
    );
    const b1 = scheduler.schedule(
      { sourceId: 'b', priority: 10 },
      controlledExecutor(pending, 'b1'),
    );
    const c1 = scheduler.schedule(
      { sourceId: 'c', priority: 10 },
      controlledExecutor(pending, 'c1'),
    );
    await Promise.resolve();

    expect(pending.map((task) => task.name)).toEqual(['a1', 'b1', 'c1']);
    expect(scheduler.stats()).toMatchObject({ active: 3, queued: 1, sources: 3 });

    pending.find((task) => task.name === 'a1')?.resolve('a1');
    await a1.promise;
    await Promise.resolve();
    expect(pending.map((task) => task.name)).toEqual(['a1', 'b1', 'c1', 'a2']);

    for (const task of pending.slice(1)) task.resolve(task.name);
    await Promise.all([a2.promise, b1.promise, c1.promise]);
  });

  it('高优先级任务在全局队列满时淘汰最新的最低优先级任务', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({
      maxConcurrency: 1,
      maxConcurrencyPerSource: 1,
      maxQueued: 2,
    });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'active'),
    );
    const firstPrefetch = scheduler.schedule(
      { sourceId: 'b', priority: 30 },
      controlledExecutor(pending, 'first-prefetch'),
    );
    const secondPrefetch = scheduler.schedule(
      { sourceId: 'c', priority: 30 },
      controlledExecutor(pending, 'second-prefetch'),
    );
    const seek = scheduler.schedule(
      { sourceId: 'd', priority: 0 },
      controlledExecutor(pending, 'seek'),
    );

    await expect(secondPrefetch.promise).rejects.toBeInstanceOf(RangeTaskPreemptedError);
    pending[0]?.resolve('active');
    await active.promise;
    await Promise.resolve();
    expect(pending[1]?.name).toBe('seek');

    pending[1]?.resolve('seek');
    await seek.promise;
    await Promise.resolve();
    pending[2]?.resolve('first-prefetch');
    await firstPrefetch.promise;
    await Promise.resolve();
    expect(pending.map((task) => task.name)).toEqual(['active', 'seek', 'first-prefetch']);
    expect(scheduler.stats()).toMatchObject({ active: 0, queued: 0, preemptions: 1 });
  });

  it('满队列不会淘汰同级任务', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 1 });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 0 },
      controlledExecutor(pending, 'active'),
    );
    const queued = scheduler.schedule(
      { sourceId: 'b', priority: 0 },
      controlledExecutor(pending, 'queued'),
    );
    const rejected = scheduler.schedule(
      { sourceId: 'c', priority: 0 },
      controlledExecutor(pending, 'rejected'),
    );

    await expect(rejected.promise).rejects.toBeInstanceOf(RangeQueueFullError);
    pending[0]?.resolve('active');
    await active.promise;
    await Promise.resolve();
    pending[1]?.resolve('queued');
    await queued.promise;
  });

  it('共享任务提升优先级后先于原有低优先级任务执行', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'active'),
    );
    const first = scheduler.schedule(
      { sourceId: 'b', priority: 20 },
      controlledExecutor(pending, 'first'),
    );
    const promoted = scheduler.schedule(
      { sourceId: 'c', priority: 30 },
      controlledExecutor(pending, 'promoted'),
    );
    promoted.promote(0);

    pending[0]?.resolve('active');
    await active.promise;
    await Promise.resolve();
    expect(pending[1]?.name).toBe('promoted');
    pending[1]?.resolve('promoted');
    await promoted.promise;
    await Promise.resolve();
    pending[2]?.resolve('first');
    await first.promise;
  });

  it('取消排队任务不会执行，取消运行任务会中止其信号', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'active'),
    );
    const queued = scheduler.schedule(
      { sourceId: 'b', priority: 10 },
      controlledExecutor(pending, 'queued'),
    );

    queued.cancel(new Error('left queue'));
    await expect(queued.promise).rejects.toThrow('left queue');
    active.cancel(new Error('session replaced'));
    await expect(active.promise).rejects.toThrow('session replaced');
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending.map((task) => task.name)).toEqual(['active']);
  });

  it('失败和忽略取消的执行器都会释放全局槽', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const failed = scheduler.schedule({ sourceId: 'a', priority: 10 }, async () => {
      throw new Error('upstream failed');
    });
    let stubbornSignal: AbortSignal | undefined;
    const stubborn = scheduler.schedule({ sourceId: 'b', priority: 10 }, (signal) => {
      stubbornSignal = signal;
      return new Promise<string>((resolve) => {
        pending.push({
          name: 'stubborn',
          signal,
          resolve,
          reject: () => undefined,
        });
      });
    });
    const next = scheduler.schedule(
      { sourceId: 'c', priority: 10 },
      controlledExecutor(pending, 'next'),
    );

    await expect(failed.promise).rejects.toThrow('upstream failed');
    await Promise.resolve();
    stubborn.cancel(new Error('cancelled'));
    expect(stubbornSignal?.aborted).toBe(true);
    pending.find((task) => task.name === 'stubborn')?.resolve('late success');
    await expect(stubborn.promise).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(pending.at(-1)?.name).toBe('next');
    pending.at(-1)?.resolve('next');
    await expect(next.promise).resolves.toBe('next');
    expect(scheduler.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('零等待队列允许空闲槽立即执行并拒绝额外等待', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxQueued: 0 });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'active'),
    );
    const rejected = scheduler.schedule(
      { sourceId: 'b', priority: 10 },
      controlledExecutor(pending, 'rejected'),
    );

    expect(pending.map((task) => task.name)).toEqual(['active']);
    await expect(rejected.promise).rejects.toBeInstanceOf(RangeQueueFullError);
    pending[0]?.resolve('active');
    await active.promise;
  });

  it('关闭调度器会中止所有任务且拒绝后续调度', async () => {
    const pending: PendingTask[] = [];
    const scheduler = new RangeScheduler({ maxConcurrency: 1 });
    const active = scheduler.schedule(
      { sourceId: 'a', priority: 10 },
      controlledExecutor(pending, 'active'),
    );
    const queued = scheduler.schedule(
      { sourceId: 'b', priority: 10 },
      controlledExecutor(pending, 'queued'),
    );

    await scheduler.close();
    await expect(active.promise).rejects.toBeInstanceOf(RangeSchedulerClosedError);
    await expect(queued.promise).rejects.toBeInstanceOf(RangeSchedulerClosedError);
    expect(() => scheduler.schedule({ sourceId: 'c', priority: 10 }, async () => 'c')).toThrow(
      RangeSchedulerClosedError,
    );
  });
});
