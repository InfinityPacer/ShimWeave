import type { PlexTimelineContext } from '@shimweave/adapter-plex';
import { describe, expect, it } from 'vitest';
import type { PlexTimelineBinding } from './plex-timeline-dispatcher.js';
import { PlexTimelineSessionStore } from './plex-timeline-session-store.js';

const reportId = 'report_identifier_123456';
const context: PlexTimelineContext = {
  origin: 'https://server.example',
  metadataPath: '/library/metadata/109591',
  ratingKey: '109591',
  token: 'private-token',
  clientParameters: [['X-Plex-Client-Identifier', 'client-1']],
};
const binding: PlexTimelineBinding = {
  tabId: 7,
  frameId: 0,
  pageOrigin: 'https://app.plex.tv',
  context,
};

describe('Plex timeline session store', () => {
  it('跨 Worker 生命周期恢复跨源页面绑定', async () => {
    const storage = new MemorySessionStorage();
    const store = new PlexTimelineSessionStore(storage, () => 1_000);
    await store.save(reportId, binding);

    expect(await store.load(reportId)).toEqual({ lastUsedAt: 1_000, binding });
    expect([...storage.values.keys()][0]).not.toContain('private-token');
  });

  it('拒绝过期或损坏的会话记录并清理存储', async () => {
    const storage = new MemorySessionStorage();
    const oldStore = new PlexTimelineSessionStore(storage, () => 0);
    await oldStore.save(reportId, binding);
    const expiredStore = new PlexTimelineSessionStore(storage, () => 25 * 60 * 60 * 1_000);

    expect(await expiredStore.load(reportId)).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it('串行化同一句柄的保存与释放，避免异步保存覆盖删除', async () => {
    const storage = new MemorySessionStorage();
    const store = new PlexTimelineSessionStore(storage, () => 1_000);
    const saved = store.save(reportId, binding);
    const removed = store.remove(reportId);

    await Promise.all([saved, removed]);
    expect(storage.values.size).toBe(0);
  });
});

class MemorySessionStorage {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}
