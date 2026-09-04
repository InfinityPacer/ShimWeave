import type { ByteRange, ByteSource } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { RANGE_PRIORITY, RangeBroker, RangeBrokerClosedError } from './range-broker.js';
import { RangeScheduler } from './range-scheduler.js';

interface PendingRead {
  range: ByteRange;
  signal: AbortSignal | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
}

class ControlledSource implements ByteSource {
  readonly sourceId = 'controlled-source';
  readonly pending: PendingRead[] = [];
  calls = 0;
  closed = false;

  getSize(): Promise<number> {
    return Promise.resolve(1024);
  }

  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.calls += 1;
    return new Promise((resolve, reject) => {
      const pending: PendingRead = { range: { ...range }, signal, resolve, reject };
      this.pending.push(pending);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  close(): void {
    this.closed = true;
  }
}

class ImmediateSource implements ByteSource {
  readonly sourceId = 'immediate-source';
  calls = 0;
  sizeCalls = 0;

  getSize(): Promise<number> {
    this.sizeCalls += 1;
    return Promise.resolve(1024);
  }

  read(range: ByteRange): Promise<Uint8Array> {
    this.calls += 1;
    return Promise.resolve(
      Uint8Array.from({ length: range.end - range.start }, (_, offset) => range.start + offset),
    );
  }

  close(): void {}
}

class RecordingSource implements ByteSource {
  readonly sourceId = 'recording-source';
  readonly ranges: ByteRange[] = [];

  constructor(readonly size: number) {}

  getSize(): Promise<number> {
    return Promise.resolve(this.size);
  }

  read(range: ByteRange): Promise<Uint8Array> {
    this.ranges.push({ ...range });
    return Promise.resolve(new Uint8Array(range.end - range.start));
  }

  close(): void {}
}

const range = (start: number, end: number): ByteRange => ({ start, end });
const bytes = (start: number, end: number): Uint8Array =>
  Uint8Array.from({ length: end - start }, (_, offset) => start + offset);

describe('RangeBroker', () => {
  it('共享覆盖相同区间的远程读取并返回对应视图', async () => {
    const source = new ControlledSource();
    const broker = new RangeBroker(source);

    const outer = broker.read(range(0, 8));
    const inner = broker.read(range(2, 6));

    expect(source.calls).toBe(1);
    source.pending[0]?.resolve(bytes(0, 8));

    await expect(outer).resolves.toEqual(bytes(0, 8));
    await expect(inner).resolves.toEqual(bytes(2, 6));
    expect(broker.stats().sharedReads).toBe(1);
  });

  it('取消一个订阅者不会中止仍被其他订阅者使用的读取', async () => {
    const source = new ControlledSource();
    const broker = new RangeBroker(source);
    const firstController = new AbortController();

    const first = broker.read(range(0, 8), firstController.signal);
    const second = broker.read(range(0, 8));
    firstController.abort(new Error('first left'));

    await expect(first).rejects.toThrow('first left');
    expect(source.pending[0]?.signal?.aborted).toBe(false);

    source.pending[0]?.resolve(bytes(0, 8));
    await expect(second).resolves.toEqual(bytes(0, 8));
  });

  it('最后一个订阅者取消时中止上游读取', async () => {
    const source = new ControlledSource();
    const broker = new RangeBroker(source);
    const controller = new AbortController();

    const reading = broker.read(range(0, 8), controller.signal);
    controller.abort(new Error('session replaced'));

    await expect(reading).rejects.toThrow('session replaced');
    expect(source.pending[0]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(broker.stats().active).toBe(0);
  });

  it('并发槽释放后优先执行 seek 而不是预取', async () => {
    const source = new ControlledSource();
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxConcurrencyPerSource: 1 });
    const broker = new RangeBroker(source, { scheduler });

    const active = broker.read(range(0, 1));
    const prefetch = broker.readWithPriority(range(1, 2), { priority: RANGE_PRIORITY.prefetch });
    const seek = broker.readWithPriority(range(2, 3), { priority: RANGE_PRIORITY.seek });

    source.pending[0]?.resolve(bytes(0, 1));
    await active;
    await Promise.resolve();
    expect(source.pending[1]?.range).toEqual(range(2, 3));

    source.pending[1]?.resolve(bytes(2, 3));
    await seek;
    await Promise.resolve();
    expect(source.pending[2]?.range).toEqual(range(1, 2));

    source.pending[2]?.resolve(bytes(1, 2));
    await prefetch;
  });

  it('多个 Broker 共享全局并发且 getSize 不会绕过调度器', async () => {
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxConcurrencyPerSource: 1 });
    const firstSource = new ControlledSource();
    const secondSource = new ImmediateSource();
    const first = new RangeBroker(firstSource, { scheduler });
    const second = new RangeBroker(secondSource, { scheduler });

    const reading = first.read(range(0, 1));
    const sizing = second.getSize();

    expect(firstSource.calls).toBe(1);
    expect(secondSource.sizeCalls).toBe(0);
    firstSource.pending[0]?.resolve(bytes(0, 1));
    await reading;
    await expect(sizing).resolves.toBe(1024);
    expect(secondSource.sizeCalls).toBe(1);

    await Promise.all([first.close(), second.close()]);
    await scheduler.close();
  });

  it('LRU 命中会续热且总字节不会超过上限', async () => {
    const source = new ImmediateSource();
    const broker = new RangeBroker(source, { maxCacheBytes: 8 });

    await broker.read(range(0, 4));
    await broker.read(range(4, 8));
    await broker.read(range(0, 4));
    await broker.read(range(8, 12));
    await broker.read(range(4, 8));

    expect(source.calls).toBe(4);
    expect(broker.stats()).toMatchObject({ cacheHits: 1, cacheBytes: 8, cacheEntries: 2 });
    expect(broker.stats().evictions).toBeGreaterThanOrEqual(2);
  });

  it('默认 LRU 以 16 MiB 为上限并淘汰最早的固定块', async () => {
    const mebibyte = 1024 * 1024;
    const source = new RecordingSource(20 * mebibyte);
    const broker = new RangeBroker(source);
    await broker.getSize();
    broker.setReadAheadBytes(4 * mebibyte);

    for (let index = 0; index < 5; index += 1) {
      await broker.read(range(index * 4 * mebibyte, (index + 1) * 4 * mebibyte));
    }
    expect(broker.stats()).toMatchObject({
      cacheBytes: 16 * mebibyte,
      cacheEntries: 4,
      evictions: 1,
    });

    await broker.read(range(0, 1));
    expect(source.ranges).toHaveLength(6);
  });

  it('已知大小后用自适应窗口合并顺序微读且随机跳转恢复小窗口', async () => {
    const mebibyte = 1024 * 1024;
    const source = new RecordingSource(16 * mebibyte);
    const broker = new RangeBroker(source);
    await broker.getSize();

    await broker.read(range(0, 7));
    await broker.read(range(7, 16));
    await broker.read(range(512 * 1024, 512 * 1024 + 32));
    await broker.read(range(12 * mebibyte + 11, 12 * mebibyte + 19));

    expect(source.ranges).toEqual([
      range(0, 512 * 1024),
      range(512 * 1024, 1536 * 1024),
      range(12 * mebibyte, 12 * mebibyte + 512 * 1024),
    ]);
    expect(broker.stats()).toMatchObject({
      cacheHits: 1,
      upstreamReads: 3,
      upstreamBytes: 2 * mebibyte,
    });
  });

  it('小文件只发起一次媒体读取且 read-ahead 不越过文件尾', async () => {
    const source = new RecordingSource(12_395);
    const broker = new RangeBroker(source);
    await broker.getSize();

    await broker.read(range(0, 7));
    await broker.read(range(40, 2_260));
    await broker.read(range(12_390, 12_395));

    expect(source.ranges).toEqual([range(0, 12_395)]);
    expect(broker.stats()).toMatchObject({
      cacheHits: 2,
      upstreamReads: 1,
      upstreamBytes: 12_395,
    });
  });

  it('固定向前播放窗口让交错音视频读取复用同一缓存区间', async () => {
    const mebibyte = 1024 * 1024;
    const source = new RecordingSource(16 * mebibyte);
    const broker = new RangeBroker(source);
    await broker.getSize();
    broker.setReadAheadBytes(4 * mebibyte);

    await broker.read(range(40, 601_211));
    await broker.read(range(601_211, 1_649_787));
    await broker.read(range(1_572_864, 2_120_378));
    await broker.read(range(4 * mebibyte + 100, 4 * mebibyte + 108));

    expect(source.ranges).toEqual([range(0, 4 * mebibyte), range(4 * mebibyte, 8 * mebibyte)]);
    expect(broker.stats()).toMatchObject({
      cacheHits: 2,
      upstreamReads: 2,
      upstreamBytes: 8 * mebibyte,
    });
  });

  it('跨固定块读取只补齐可复用块并保持调用方的精确区间', async () => {
    const mebibyte = 1024 * 1024;
    const source = new RecordingSource(16 * mebibyte);
    const broker = new RangeBroker(source);
    await broker.getSize();
    broker.setReadAheadBytes(4 * mebibyte);

    const first = await broker.read(range(0, 4 * mebibyte));
    const crossing = await broker.read(range(4 * mebibyte - 16, 4 * mebibyte + 16));

    expect(first.byteLength).toBe(4 * mebibyte);
    expect(crossing.byteLength).toBe(32);
    expect(source.ranges).toEqual([range(0, 4 * mebibyte), range(4 * mebibyte, 8 * mebibyte)]);
    expect(broker.stats()).toMatchObject({ cacheHits: 1, cacheMisses: 2 });
  });

  it('并发交错读取共享相同固定块而不重复访问上游', async () => {
    const mebibyte = 1024 * 1024;
    const source = new RecordingSource(16 * mebibyte);
    const broker = new RangeBroker(source);
    await broker.getSize();
    broker.setReadAheadBytes(4 * mebibyte);

    const crossing = broker.read(range(4 * mebibyte - 16, 4 * mebibyte + 16));
    const audio = broker.read(range(4 * mebibyte + 1, 4 * mebibyte + 32));
    await Promise.all([crossing, audio]);

    expect(source.ranges).toEqual([range(0, 4 * mebibyte), range(4 * mebibyte, 8 * mebibyte)]);
    expect(broker.stats()).toMatchObject({ upstreamReads: 2, sharedReads: 1 });
  });

  it('拒绝非有限优先级', () => {
    const broker = new RangeBroker(new ImmediateSource());

    expect(() => broker.readWithPriority(range(0, 1), { priority: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() =>
      broker.readWithPriority(range(0, 1), { priority: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });

  it('取消排队任务后永远不会访问上游', async () => {
    const source = new ControlledSource();
    const scheduler = new RangeScheduler({ maxConcurrency: 1, maxConcurrencyPerSource: 1 });
    const broker = new RangeBroker(source, { scheduler });
    const controller = new AbortController();

    const active = broker.read(range(0, 1));
    const queued = broker.read(range(1, 2), controller.signal);
    controller.abort(new Error('left queue'));
    await expect(queued).rejects.toThrow('left queue');

    source.pending[0]?.resolve(bytes(0, 1));
    await active;
    await Promise.resolve();
    expect(source.calls).toBe(1);
  });

  it('LRU 同时限制条目数量并压紧上游返回的共享视图', async () => {
    const backing = Uint8Array.from({ length: 1024 }, (_, index) => index);
    const source: ByteSource = {
      sourceId: 'shared-buffer-source',
      getSize: async () => backing.byteLength,
      read: async ({ start, end }) => backing.subarray(start, end),
      close: () => undefined,
    };
    const broker = new RangeBroker(source, {
      maxCacheBytes: 1024,
      maxCacheEntries: 2,
    });

    await broker.read(range(0, 1));
    await broker.read(range(1, 2));
    await broker.read(range(2, 3));
    const cached = await broker.read(range(2, 3));

    expect(cached.buffer.byteLength).toBe(1);
    expect(broker.stats()).toMatchObject({
      cacheEntries: 2,
      cacheBytes: 2,
      cacheHits: 1,
      evictions: 1,
    });
  });

  it('拒绝无效区间和长度不匹配的源响应', async () => {
    const source = new ControlledSource();
    const broker = new RangeBroker(source);

    expect(() => broker.read(range(3, 3))).toThrow(RangeError);

    const reading = broker.read(range(0, 4));
    source.pending[0]?.resolve(bytes(0, 3));
    await expect(reading).rejects.toThrow('expected 4');
  });

  it('复用成功的尺寸查询并在已知边界外读取前拒绝', async () => {
    const source = new ImmediateSource();
    const broker = new RangeBroker(source);

    await expect(Promise.all([broker.getSize(), broker.getSize()])).resolves.toEqual([1024, 1024]);
    await expect(broker.getSize()).resolves.toBe(1024);
    expect(source.sizeCalls).toBe(1);
    expect(() => broker.read(range(1020, 1025))).toThrow(RangeError);
    expect(source.calls).toBe(0);
  });

  it('尺寸查询失败后允许下一次调用重试', async () => {
    let calls = 0;
    const source: ByteSource = {
      sourceId: 'retry-size',
      getSize: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary failure');
        return 10;
      },
      read: async () => new Uint8Array(),
      close: () => undefined,
    };
    const broker = new RangeBroker(source);

    await expect(broker.getSize()).rejects.toThrow('temporary failure');
    await expect(broker.getSize()).resolves.toBe(10);
    expect(calls).toBe(2);
  });

  it('尺寸查询的最后订阅者取消时中止上游并允许新请求', async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const source: ByteSource = {
      sourceId: 'cancel-size',
      getSize: async (signal) => {
        calls += 1;
        if (calls > 1) return 10;
        firstSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      read: async () => new Uint8Array(),
      close: () => undefined,
    };
    const broker = new RangeBroker(source);
    const controller = new AbortController();

    const first = broker.getSize(controller.signal);
    controller.abort(new Error('session left'));

    await expect(first).rejects.toThrow('session left');
    expect(firstSignal?.aborted).toBe(true);
    await expect(broker.getSize()).resolves.toBe(10);
    expect(calls).toBe(2);
  });

  it('关闭时终止任务、清空缓存并关闭底层源', async () => {
    const source = new ControlledSource();
    const broker = new RangeBroker(source);
    const reading = broker.read(range(0, 4));

    await broker.close();

    await expect(reading).rejects.toBeInstanceOf(RangeBrokerClosedError);
    expect(source.closed).toBe(true);
    expect(broker.stats()).toMatchObject({ active: 0, queued: 0, cacheBytes: 0 });
    expect(() => broker.read(range(0, 1))).toThrow(RangeBrokerClosedError);
  });
});
