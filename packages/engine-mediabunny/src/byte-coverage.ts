/**
 * 记录视频流在当前播放代次里已经读取过的字节区间。字幕读取只访问这些区间，
 * 因而只会命中刚读过的缓存，不会发起额外下载，也不会跑到视频前面。
 */
export class ByteCoverage {
  /** 按起点排序、互不相邻的半开区间。 */
  private intervals: { start: number; end: number }[] = [];
  private readonly waiters = new Set<() => void>();
  private closedReason: unknown;

  constructor(private readonly maxIntervals = 256) {}

  add(start: number, end: number): void {
    if (this.closedReason !== undefined || !(end > start)) return;
    const merged = { start, end };
    const kept: { start: number; end: number }[] = [];
    for (const interval of this.intervals) {
      if (interval.end < merged.start || interval.start > merged.end) {
        kept.push(interval);
        continue;
      }
      merged.start = Math.min(merged.start, interval.start);
      merged.end = Math.max(merged.end, interval.end);
    }
    kept.push(merged);
    kept.sort((left, right) => left.start - right.start);
    // 区间过多时丢掉最早的片段；字幕读取只向后推进，旧片段不会再用到。
    this.intervals = kept.length > this.maxIntervals ? kept.slice(-this.maxIntervals) : kept;
    this.notify();
  }

  covers(start: number, end: number): boolean {
    return this.intervals.some((interval) => interval.start <= start && end <= interval.end);
  }

  /** 已覆盖且位于 from 之后的第一个候选位置，用于在视频流跳过的簇之后重新对齐。 */
  firstCoveredAfter(from: number, candidates: readonly number[]): number | undefined {
    return candidates.find((position) => position > from && this.covers(position, position + 1));
  }

  /** 等待下一次覆盖变化；关闭后立即以关闭原因拒绝。 */
  changed(signal: AbortSignal): Promise<void> {
    if (this.closedReason !== undefined) return Promise.reject(this.closedReason);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.delete(wake);
        reject(signal.reason);
      };
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (this.closedReason !== undefined) reject(this.closedReason);
        else resolve();
      };
      this.waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(reason: unknown): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason ?? new Error('Byte coverage closed');
    this.intervals = [];
    this.notify();
  }

  private notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
