import type { PlexTimelineBinding } from './plex-timeline-dispatcher.js';

interface SessionStorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

interface StoredTimelineBinding {
  schema: 1;
  lastUsedAt: number;
  binding: PlexTimelineBinding;
}

export interface LoadedTimelineBinding {
  lastUsedAt: number;
  binding: PlexTimelineBinding;
}

const KEY_PREFIX = 'plex-timeline-binding:';
const RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Timeline 凭据保存在 Chrome 的内存会话区，使短生命周期 MV3 Worker 重启后仍能恢复播放回写。
 * 该存储区默认不暴露给内容脚本，并在浏览器会话结束时清空。
 */
export class PlexTimelineSessionStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: SessionStorageArea,
    private readonly now: () => number = Date.now,
  ) {}

  async save(reportId: string, binding: PlexTimelineBinding): Promise<void> {
    if (!opaqueId(reportId)) return;
    const key = storageKey(reportId);
    const value: StoredTimelineBinding = {
      schema: 1,
      lastUsedAt: this.now(),
      binding,
    };
    await this.enqueue(key, () => this.storage.set({ [key]: value }));
  }

  async load(reportId: string): Promise<LoadedTimelineBinding | undefined> {
    if (!opaqueId(reportId)) return undefined;
    const key = storageKey(reportId);
    await this.writes.get(key)?.catch(() => undefined);
    const values = await this.storage.get(key);
    const stored = parseStoredTimelineBinding(values[key]);
    if (!stored || stored.lastUsedAt < this.now() - RETENTION_MILLISECONDS) {
      await this.storage.remove(key);
      return undefined;
    }
    return { lastUsedAt: stored.lastUsedAt, binding: stored.binding };
  }

  async remove(reportId: string): Promise<void> {
    if (!opaqueId(reportId)) return;
    const key = storageKey(reportId);
    await this.enqueue(key, () => this.storage.remove(key));
  }

  private async enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writes.set(key, current);
    try {
      await current;
    } finally {
      if (this.writes.get(key) === current) this.writes.delete(key);
    }
  }
}

const storageKey = (reportId: string): string => `${KEY_PREFIX}${reportId}`;

const parseStoredTimelineBinding = (value: unknown): StoredTimelineBinding | undefined => {
  if (!isRecord(value) || value.schema !== 1 || !finiteNonNegativeNumber(value.lastUsedAt)) {
    return undefined;
  }
  const binding = value.binding;
  if (
    !isRecord(binding) ||
    !Number.isSafeInteger(binding.tabId) ||
    Number(binding.tabId) < 0 ||
    binding.frameId !== 0 ||
    !httpOrigin(binding.pageOrigin) ||
    !isRecord(binding.context)
  ) {
    return undefined;
  }
  const context = binding.context;
  if (
    !httpOrigin(context.origin) ||
    typeof context.metadataPath !== 'string' ||
    typeof context.ratingKey !== 'string' ||
    context.metadataPath !== `/library/metadata/${context.ratingKey}` ||
    typeof context.token !== 'string' ||
    context.token.length === 0 ||
    !clientParameters(context.clientParameters)
  ) {
    return undefined;
  }
  return value as unknown as StoredTimelineBinding;
};

const clientParameters = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      entry.every((part) => typeof part === 'string' && part.length > 0),
  );

const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

const httpOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
};

const finiteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
