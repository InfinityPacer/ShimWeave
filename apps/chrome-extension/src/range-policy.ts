import type { RangeSchedulerOptions } from '@shimweave/core';

/**
 * 单源保留两个并发槽以并行读取音视频轨；control-v1 保证每个 Range
 * 独立换取一次 CDN 地址，不依赖降低并发规避短期 URL 复用限制。
 */
export const MEDIA_RANGE_SCHEDULER_OPTIONS = {
  maxConcurrency: 6,
  maxConcurrencyPerSource: 2,
  maxQueued: 256,
} as const satisfies RangeSchedulerOptions;
