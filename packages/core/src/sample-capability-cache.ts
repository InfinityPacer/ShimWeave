import type { CapabilityScope, SampleCapabilityEvidence } from '@shimweave/contracts';
import { createSampleCacheKey } from './capability-identity.js';

export type CacheableSampleEvidence = Exclude<SampleCapabilityEvidence, { support: 'unknown' }>;

export interface StoredSampleEvidence {
  key: string;
  evidence: CacheableSampleEvidence;
  lastAccessedAt: number;
}

/**
 * 媒体级能力缓存不能让某个播放位置的局部失败推翻已经验证的成功路径。
 * 成功证据按完成度保留，尚无成功证据时才使用最新的确定性失败。
 */
export const selectPreferredSampleEvidence = (
  existing: CacheableSampleEvidence | undefined,
  incoming: CacheableSampleEvidence,
): CacheableSampleEvidence => {
  if (!existing) return incoming;
  if (existing.support === 'supported' && incoming.support === 'unsupported') return existing;
  if (existing.support === 'unsupported' && incoming.support === 'supported') return incoming;
  if (existing.support === 'supported' && incoming.support === 'supported') {
    const existingStrength = SAMPLE_MILESTONE_STRENGTH[existing.milestone];
    const incomingStrength = SAMPLE_MILESTONE_STRENGTH[incoming.milestone];
    if (existingStrength !== incomingStrength) {
      return existingStrength > incomingStrength ? existing : incoming;
    }
  }
  return existing.observedAt > incoming.observedAt ? existing : incoming;
};

const SAMPLE_MILESTONE_STRENGTH = {
  'first-frame': 1,
  'steady-playback': 2,
  'seek-resume': 3,
} as const;

export interface SampleEvidenceRepository {
  read(key: string): Promise<StoredSampleEvidence | undefined>;
  writeIfNewer(record: StoredSampleEvidence): Promise<StoredSampleEvidence>;
  touch(key: string, lastAccessedAt: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteOlderThan(cutoff: number): Promise<number>;
  close?(): void;
}

export interface CapabilitySampleCacheOptions {
  maxMemoryEntries?: number;
  retentionMilliseconds?: number;
  persistenceTouchIntervalMilliseconds?: number;
  now?: () => number;
  onPersistenceError?: (error: unknown) => void;
}

const DEFAULT_RETENTION_MILLISECONDS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_TOUCH_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

/**
 * 真实样本按 runtime、engine、精确配置和媒体指纹隔离。有效性由身份变化驱动，保留期只负责 GC。
 */
export class CapabilitySampleCache {
  private readonly memory = new Map<string, StoredSampleEvidence>();
  private readonly pendingReads = new Map<string, Promise<CacheableSampleEvidence | undefined>>();
  private readonly maxMemoryEntries: number;
  private readonly retentionMilliseconds: number;
  private readonly persistenceTouchIntervalMilliseconds: number;
  private readonly now: () => number;
  private readonly onPersistenceError: ((error: unknown) => void) | undefined;

  constructor(
    private readonly scope: CapabilityScope,
    private readonly repository: SampleEvidenceRepository,
    options: CapabilitySampleCacheOptions = {},
  ) {
    this.maxMemoryEntries = positiveInteger(options.maxMemoryEntries ?? 256, 'maxMemoryEntries');
    this.retentionMilliseconds = positiveInteger(
      options.retentionMilliseconds ?? DEFAULT_RETENTION_MILLISECONDS,
      'retentionMilliseconds',
    );
    this.persistenceTouchIntervalMilliseconds = positiveInteger(
      options.persistenceTouchIntervalMilliseconds ?? DEFAULT_TOUCH_INTERVAL_MILLISECONDS,
      'persistenceTouchIntervalMilliseconds',
    );
    this.now = options.now ?? Date.now;
    this.onPersistenceError = options.onPersistenceError;
  }

  peek(configurationKey: string, mediaFingerprint: string): CacheableSampleEvidence | undefined {
    const key = createSampleCacheKey(this.scope, configurationKey, mediaFingerprint);
    const record = this.memory.get(key);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.memory.delete(key);
      this.observe(this.repository.delete(key));
      return undefined;
    }
    this.memory.delete(key);
    this.memory.set(key, record);
    this.scheduleTouch(record);
    return record.evidence;
  }

  get(
    configurationKey: string,
    mediaFingerprint: string,
  ): Promise<CacheableSampleEvidence | undefined> {
    const hot = this.peek(configurationKey, mediaFingerprint);
    if (hot) return Promise.resolve(hot);
    const key = createSampleCacheKey(this.scope, configurationKey, mediaFingerprint);
    const existing = this.pendingReads.get(key);
    if (existing) return existing;
    const pending = this.load(key, configurationKey, mediaFingerprint).finally(() => {
      this.pendingReads.delete(key);
    });
    this.pendingReads.set(key, pending);
    return pending;
  }

  async put(evidence: SampleCapabilityEvidence): Promise<boolean> {
    if (evidence.support === 'unknown') return false;
    const key = createSampleCacheKey(
      this.scope,
      evidence.configurationKey,
      evidence.mediaFingerprint,
    );
    const existing = this.memory.get(key);
    if (
      existing &&
      selectPreferredSampleEvidence(existing.evidence, evidence) === existing.evidence
    ) {
      return false;
    }
    const record = await this.repository.writeIfNewer({
      key,
      evidence,
      lastAccessedAt: this.now(),
    });
    this.remember(record);
    return record.evidence.observedAt === evidence.observedAt;
  }

  async prune(): Promise<number> {
    const cutoff = this.now() - this.retentionMilliseconds;
    for (const [key, record] of this.memory) {
      if (record.lastAccessedAt < cutoff) this.memory.delete(key);
    }
    return this.repository.deleteOlderThan(cutoff);
  }

  clearMemory(): void {
    this.memory.clear();
  }

  close(): void {
    this.memory.clear();
    this.pendingReads.clear();
    this.repository.close?.();
  }

  private async load(
    key: string,
    configurationKey: string,
    mediaFingerprint: string,
  ): Promise<CacheableSampleEvidence | undefined> {
    const record = await this.repository.read(key);
    if (!record) return undefined;
    if (
      this.isExpired(record) ||
      record.evidence.configurationKey !== configurationKey ||
      record.evidence.mediaFingerprint !== mediaFingerprint ||
      createSampleCacheKey(
        this.scope,
        record.evidence.configurationKey,
        record.evidence.mediaFingerprint,
      ) !== key
    ) {
      await this.repository.delete(key);
      return undefined;
    }
    this.remember(record);
    this.scheduleTouch(record);
    return record.evidence;
  }

  private remember(record: StoredSampleEvidence): void {
    this.memory.delete(record.key);
    this.memory.set(record.key, record);
    while (this.memory.size > this.maxMemoryEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private scheduleTouch(record: StoredSampleEvidence): void {
    const now = this.now();
    if (now - record.lastAccessedAt < this.persistenceTouchIntervalMilliseconds) return;
    record.lastAccessedAt = now;
    this.observe(this.repository.touch(record.key, now));
  }

  private isExpired(record: StoredSampleEvidence): boolean {
    return record.lastAccessedAt < this.now() - this.retentionMilliseconds;
  }

  private observe(operation: Promise<unknown>): void {
    void operation.catch((error: unknown) => this.onPersistenceError?.(error));
  }
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
