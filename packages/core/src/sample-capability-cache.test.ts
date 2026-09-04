import type {
  CapabilityScope,
  SampleCapabilityEvidence,
  SupportedSampleCapabilityEvidence,
} from '@shimweave/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createSampleCacheKey } from './capability-identity.js';
import {
  CapabilitySampleCache,
  type SampleEvidenceRepository,
  type StoredSampleEvidence,
  selectPreferredSampleEvidence,
} from './sample-capability-cache.js';

class MemoryRepository implements SampleEvidenceRepository {
  readonly records = new Map<string, StoredSampleEvidence>();
  reads = 0;
  touches = 0;

  read(key: string): Promise<StoredSampleEvidence | undefined> {
    this.reads += 1;
    return Promise.resolve(this.records.get(key));
  }

  writeIfNewer(record: StoredSampleEvidence): Promise<StoredSampleEvidence> {
    const existing = this.records.get(record.key);
    const selectedEvidence = selectPreferredSampleEvidence(existing?.evidence, record.evidence);
    const selected = existing?.evidence === selectedEvidence ? existing : record;
    this.records.set(record.key, selected);
    return Promise.resolve(selected);
  }

  touch(key: string, lastAccessedAt: number): Promise<void> {
    this.touches += 1;
    const existing = this.records.get(key);
    if (existing) this.records.set(key, { ...existing, lastAccessedAt });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  deleteOlderThan(cutoff: number): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.lastAccessedAt < cutoff) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

const scope: CapabilityScope = {
  schemaVersion: 1,
  runtimeKey: 'runtime-a',
  engineKey: 'engine-a',
};

const sample = (
  configurationKey = 'configuration-a',
  mediaFingerprint = 'media-a',
  observedAt = 100,
): SupportedSampleCapabilityEvidence => ({
  kind: 'sample',
  path: 'mse-remux',
  configurationKey,
  mediaFingerprint,
  support: 'supported',
  milestone: 'steady-playback',
  observedAt,
});

describe('CapabilitySampleCache', () => {
  it('热命中只访问 L1，并按最近使用顺序淘汰', async () => {
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository, { maxMemoryEntries: 2 });
    await cache.put(sample('a'));
    await cache.put(sample('b'));
    expect(cache.peek('a', 'media-a')).toMatchObject({ configurationKey: 'a' });
    await cache.put(sample('c'));

    expect(cache.peek('a', 'media-a')).toBeDefined();
    expect(cache.peek('b', 'media-a')).toBeUndefined();
    expect(cache.peek('c', 'media-a')).toBeDefined();
    expect(repository.reads).toBe(0);
  });

  it('冷命中合并并发读取并回填 L1', async () => {
    const repository = new MemoryRepository();
    const evidence = sample();
    repository.records.set(createSampleCacheKey(scope, 'configuration-a', 'media-a'), {
      key: createSampleCacheKey(scope, 'configuration-a', 'media-a'),
      evidence: { ...evidence, support: 'supported' },
      lastAccessedAt: 100,
    });
    const cache = new CapabilitySampleCache(scope, repository, { now: () => 100 });

    const [first, second] = await Promise.all([
      cache.get('configuration-a', 'media-a'),
      cache.get('configuration-a', 'media-a'),
    ]);
    expect(first).toEqual(second);
    expect(repository.reads).toBe(1);
    expect(cache.peek('configuration-a', 'media-a')).toEqual(first);
  });

  it('网络、配额和取消错误不进入持久能力缓存', async () => {
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository);
    const transient: SampleCapabilityEvidence = {
      ...sample(),
      support: 'unknown',
      failureClass: 'network',
    };

    await expect(cache.put(transient)).resolves.toBe(false);
    expect(repository.records.size).toBe(0);
  });

  it('跨标签迟到的旧结论不能覆盖较新样本', async () => {
    const repository = new MemoryRepository();
    const first = new CapabilitySampleCache(scope, repository);
    const second = new CapabilitySampleCache(scope, repository);
    await first.put(sample('configuration-a', 'media-a', 200));
    await expect(second.put(sample('configuration-a', 'media-a', 100))).resolves.toBe(false);
    second.clearMemory();
    await expect(second.get('configuration-a', 'media-a')).resolves.toMatchObject({
      observedAt: 200,
    });
  });

  it('局部失败不能覆盖成功证据，后续成功可以修正失败结论', async () => {
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository);
    await cache.put(sample('configuration-a', 'media-a', 100));
    await expect(
      cache.put({
        ...sample('configuration-a', 'media-a', 200),
        support: 'unsupported',
        failureClass: 'decode',
      }),
    ).resolves.toBe(false);
    expect(cache.peek('configuration-a', 'media-a')).toMatchObject({
      support: 'supported',
      observedAt: 100,
    });

    const second = new CapabilitySampleCache(scope, repository);
    const failedFirst = {
      ...sample('configuration-b', 'media-b', 100),
      support: 'unsupported' as const,
      failureClass: 'append' as const,
    };
    await second.put(failedFirst);
    await second.put(sample('configuration-b', 'media-b', 50));
    expect(second.peek('configuration-b', 'media-b')).toMatchObject({
      support: 'supported',
      observedAt: 50,
    });
  });

  it('保留完成度更高的成功样本，不被较新的首帧样本降级', async () => {
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository);
    await cache.put(sample('configuration-a', 'media-a', 100));
    await cache.put({
      ...sample('configuration-a', 'media-a', 200),
      milestone: 'first-frame',
    });
    expect(cache.peek('configuration-a', 'media-a')).toMatchObject({
      milestone: 'steady-playback',
      observedAt: 100,
    });
  });

  it('身份不匹配或记录过期时拒绝复用并清理持久记录', async () => {
    let now = 200;
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository, {
      now: () => now,
      retentionMilliseconds: 50,
    });
    await cache.put(sample());
    now = 251;
    expect(cache.peek('configuration-a', 'media-a')).toBeUndefined();
    await Promise.resolve();
    expect(repository.records.size).toBe(0);

    const wrongKey = createSampleCacheKey(scope, 'configuration-b', 'media-b');
    repository.records.set(wrongKey, {
      key: wrongKey,
      evidence: { ...sample('configuration-a', 'media-a'), support: 'supported' },
      lastAccessedAt: now,
    });
    await expect(cache.get('configuration-b', 'media-b')).resolves.toBeUndefined();
    expect(repository.records.has(wrongKey)).toBe(false);
  });

  it('活跃记录低频续期，GC 不成为播放热路径的同步成本', async () => {
    let now = 100;
    const repository = new MemoryRepository();
    const onPersistenceError = vi.fn();
    const cache = new CapabilitySampleCache(scope, repository, {
      now: () => now,
      retentionMilliseconds: 1000,
      persistenceTouchIntervalMilliseconds: 100,
      onPersistenceError,
    });
    await cache.put(sample());
    now = 150;
    cache.peek('configuration-a', 'media-a');
    expect(repository.touches).toBe(0);
    now = 201;
    cache.peek('configuration-a', 'media-a');
    await Promise.resolve();
    expect(repository.touches).toBe(1);
    expect(onPersistenceError).not.toHaveBeenCalled();
  });

  it('prune 仅回收长期未访问记录，不改变仍有效的身份语义', async () => {
    const repository = new MemoryRepository();
    const cache = new CapabilitySampleCache(scope, repository, {
      now: () => 1000,
      retentionMilliseconds: 100,
    });
    const oldKey = createSampleCacheKey(scope, 'old', 'media-a');
    const activeKey = createSampleCacheKey(scope, 'active', 'media-a');
    repository.records.set(oldKey, {
      key: oldKey,
      evidence: { ...sample('old'), support: 'supported' },
      lastAccessedAt: 899,
    });
    repository.records.set(activeKey, {
      key: activeKey,
      evidence: { ...sample('active'), support: 'supported' },
      lastAccessedAt: 900,
    });

    await expect(cache.prune()).resolves.toBe(1);
    expect(repository.records.has(oldKey)).toBe(false);
    expect(repository.records.has(activeKey)).toBe(true);
  });
});
