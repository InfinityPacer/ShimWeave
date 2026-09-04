import { createPlexTimelineRequest, type PlexTimelineContext } from '@shimweave/adapter-plex';
import {
  PLEX_TIMELINE_RELEASE_MESSAGE,
  type PlexTimelineMessage,
} from './plex-timeline-protocol.js';

export interface PlexTimelineBinding {
  tabId: number;
  frameId: number;
  pageOrigin: string;
  context: PlexTimelineContext;
}

export interface PlexTimelineSender {
  tabId: number | undefined;
  frameId: number | undefined;
  pageOrigin: string | undefined;
}

interface TimelineEntry extends PlexTimelineBinding {
  lastUsedAt: number;
  tail: Promise<void>;
  closing: boolean;
}

export interface PlexTimelineDispatcherOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  retentionMilliseconds?: number;
  requestTimeoutMilliseconds?: number;
  onRegistered?(reportId: string, binding: PlexTimelineBinding): void | Promise<void>;
  onDeleted?(reportId: string): void | Promise<void>;
}

export interface PlexTimelineDiagnostics {
  activeReports: number;
  acceptedUpdates: number;
  requestAttempts: number;
  successfulUpdates: number;
  failedUpdates: number;
  lastStatus: number | null;
  lastError: string | null;
  lastErrorMessage: string | null;
}

/**
 * 凭据只存在于后台绑定中。每个播放会话的请求严格串行，避免迟到的 playing 覆盖 paused/stopped。
 */
export class PlexTimelineDispatcher {
  private readonly entries = new Map<string, TimelineEntry>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly retentionMilliseconds: number;
  private readonly requestTimeoutMilliseconds: number;
  private readonly onRegistered:
    | ((reportId: string, binding: PlexTimelineBinding) => void | Promise<void>)
    | undefined;
  private readonly onDeleted: ((reportId: string) => void | Promise<void>) | undefined;
  private acceptedUpdates = 0;
  private requestAttempts = 0;
  private successfulUpdates = 0;
  private failedUpdates = 0;
  private lastStatus: number | null = null;
  private lastError: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(options: PlexTimelineDispatcherOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 64;
    this.retentionMilliseconds = options.retentionMilliseconds ?? 6 * 60 * 60 * 1000;
    this.requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 5_000;
    this.onRegistered = options.onRegistered;
    this.onDeleted = options.onDeleted;
  }

  get size(): number {
    return this.entries.size;
  }

  get diagnostics(): PlexTimelineDiagnostics {
    return {
      activeReports: this.entries.size,
      acceptedUpdates: this.acceptedUpdates,
      requestAttempts: this.requestAttempts,
      successfulUpdates: this.successfulUpdates,
      failedUpdates: this.failedUpdates,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  has(reportId: string): boolean {
    return this.entries.has(reportId);
  }

  register(reportId: string, binding: PlexTimelineBinding): void {
    this.prune();
    this.entries.set(reportId, {
      ...binding,
      lastUsedAt: this.now(),
      tail: Promise.resolve(),
      closing: false,
    });
    this.runHook(this.onRegistered, reportId, binding);
    this.enforceCapacity();
  }

  restore(reportId: string, binding: PlexTimelineBinding, lastUsedAt: number): void {
    this.prune();
    this.entries.set(reportId, {
      ...binding,
      lastUsedAt,
      tail: Promise.resolve(),
      closing: false,
    });
    this.enforceCapacity();
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  dispatch(message: PlexTimelineMessage, sender: PlexTimelineSender): Promise<boolean> {
    const entry = this.entries.get(message.reportId);
    if (!entry || entry.closing || !sameSender(entry, sender)) return Promise.resolve(false);
    entry.lastUsedAt = this.now();
    if (message.type === PLEX_TIMELINE_RELEASE_MESSAGE) {
      entry.closing = true;
      return entry.tail.then(() => {
        this.deleteIfCurrent(message.reportId, entry);
        return true;
      });
    }

    this.acceptedUpdates += 1;
    entry.tail = entry.tail.then(() =>
      this.sendTimeline(entry.context, {
        state: message.state,
        timeSeconds: message.timeSeconds,
        durationSeconds: message.durationSeconds,
      }),
    );
    if (message.release) {
      entry.closing = true;
    }
    return entry.tail.then(() => {
      if (message.release) this.deleteIfCurrent(message.reportId, entry);
      return true;
    });
  }

  private async sendTimeline(
    context: PlexTimelineContext,
    update: Parameters<typeof createPlexTimelineRequest>[1],
  ): Promise<void> {
    const request = createPlexTimelineRequest(context, update);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMilliseconds);
      try {
        this.requestAttempts += 1;
        const response = await this.fetcher(request.url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Plex-Token': request.token },
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        });
        this.lastStatus = response.status;
        this.lastError = null;
        this.lastErrorMessage = null;
        if (response.ok) {
          this.successfulUpdates += 1;
          return;
        }
        if (response.status < 500) {
          this.failedUpdates += 1;
          return;
        }
      } catch (error) {
        this.lastStatus = null;
        this.lastError = safeErrorName(error);
        this.lastErrorMessage = safeErrorMessage(error);
        // 状态回写是旁路能力，瞬态失败只允许一次重试且不能进入媒体播放链路。
      } finally {
        clearTimeout(timeout);
      }
    }
    this.failedUpdates += 1;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMilliseconds;
    for (const [reportId, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) this.delete(reportId);
    }
  }

  private deleteIfCurrent(reportId: string, entry: TimelineEntry): void {
    if (this.entries.get(reportId) === entry) this.delete(reportId);
  }

  private delete(reportId: string): void {
    if (!this.entries.delete(reportId)) return;
    this.runHook(this.onDeleted, reportId);
  }

  private runHook(
    hook: ((reportId: string, binding: PlexTimelineBinding) => void | Promise<void>) | undefined,
    reportId: string,
    binding?: PlexTimelineBinding,
  ): void {
    if (!hook) return;
    try {
      void Promise.resolve(hook(reportId, binding as PlexTimelineBinding)).catch(() => undefined);
    } catch {
      // 会话存储失败不得阻塞 Plex 回写或媒体播放。
    }
  }
}

const sameSender = (binding: PlexTimelineBinding, sender: PlexTimelineSender): boolean =>
  sender.tabId === binding.tabId &&
  sender.frameId === binding.frameId &&
  sender.pageOrigin === binding.pageOrigin;

const safeErrorName = (error: unknown): string => {
  if (error instanceof DOMException || error instanceof Error) return error.name;
  return typeof error;
};

const safeErrorMessage = (error: unknown): string | null => {
  if (!(error instanceof DOMException) && !(error instanceof Error)) return null;
  return error.message
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/[A-Za-z0-9_-]{16,}/gu, '[value]')
    .slice(0, 160);
};
