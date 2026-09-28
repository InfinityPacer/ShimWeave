import { describe, expect, it } from 'vitest';
import { ByteCoverage } from './byte-coverage.js';

describe('ByteCoverage', () => {
  it('合并相邻和重叠区间后判断覆盖', () => {
    const coverage = new ByteCoverage();
    coverage.add(0, 10);
    coverage.add(10, 20);
    coverage.add(30, 40);
    coverage.add(15, 32);

    expect(coverage.covers(0, 40)).toBe(true);
    expect(coverage.covers(0, 41)).toBe(false);
    expect(coverage.firstCoveredAfter(5, [3, 8, 50])).toBe(8);
  });

  it('覆盖变化唤醒等待者，关闭后拒绝并清空', async () => {
    const coverage = new ByteCoverage();
    const controller = new AbortController();
    const waiting = coverage.changed(controller.signal);
    coverage.add(0, 1);
    await expect(waiting).resolves.toBeUndefined();

    const reason = new Error('closed');
    const pending = coverage.changed(controller.signal);
    coverage.close(reason);
    await expect(pending).rejects.toBe(reason);
    expect(coverage.covers(0, 1)).toBe(false);
  });

  it('等待可以被取消，区间数量有上限', async () => {
    const coverage = new ByteCoverage(2);
    const controller = new AbortController();
    const waiting = coverage.changed(controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');

    coverage.add(0, 1);
    coverage.add(10, 11);
    coverage.add(20, 21);
    expect(coverage.covers(0, 1)).toBe(false);
    expect(coverage.covers(20, 21)).toBe(true);
  });
});
