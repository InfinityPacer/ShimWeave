import type { PlexTimelineContext } from '@shimweave/adapter-plex';
import { describe, expect, it, vi } from 'vitest';
import { PlexTimelineDispatcher } from './plex-timeline-dispatcher.js';
import {
  PLEX_TIMELINE_RELEASE_MESSAGE,
  PLEX_TIMELINE_REPORT_MESSAGE,
} from './plex-timeline-protocol.js';

const reportId = 'report_identifier_123456';
const sender = { tabId: 7, frameId: 0, pageOrigin: 'https://app.plex.tv' };
const context: PlexTimelineContext = {
  origin: 'https://plex.example',
  metadataPath: '/library/metadata/109591',
  ratingKey: '109591',
  token: 'private-token',
  clientParameters: [['X-Plex-Client-Identifier', 'client-1']],
};

describe('Plex timeline dispatcher', () => {
  it('校验发送页面并按会话串行发送状态', async () => {
    const first = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(new Response(null, { status: 200 }));
    const dispatcher = new PlexTimelineDispatcher({ fetcher });
    dispatcher.register(reportId, { ...sender, context });

    const playing = dispatcher.dispatch(
      {
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'playing',
        timeSeconds: 10,
        durationSeconds: 100,
      },
      sender,
    );
    const paused = dispatcher.dispatch(
      {
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'paused',
        timeSeconds: 11,
        durationSeconds: 100,
      },
      sender,
    );
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(playing).resolves.toBe(true);
    await expect(paused).resolves.toBe(true);
    expect(dispatcher.diagnostics).toEqual({
      activeReports: 1,
      acceptedUpdates: 2,
      requestAttempts: 2,
      successfulUpdates: 2,
      failedUpdates: 0,
      lastStatus: 200,
      lastError: null,
      lastErrorMessage: null,
    });

    const firstRequest = fetcher.mock.calls[0];
    expect(firstRequest?.[0]).not.toContain('private-token');
    expect(new Headers(firstRequest?.[1]?.headers).get('X-Plex-Token')).toBe('private-token');
    await expect(
      dispatcher.dispatch(
        { type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId },
        { ...sender, tabId: 8 },
      ),
    ).resolves.toBe(false);
  });

  it('瞬态失败只重试一次且释放后拒绝旧消息', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const dispatcher = new PlexTimelineDispatcher({ fetcher });
    dispatcher.register(reportId, { ...sender, context });
    const stopped = dispatcher.dispatch(
      {
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'stopped',
        timeSeconds: 100,
        durationSeconds: 100,
        release: true,
      },
      sender,
    );

    await expect(
      dispatcher.dispatch(
        {
          type: PLEX_TIMELINE_REPORT_MESSAGE,
          reportId,
          state: 'playing',
          timeSeconds: 10,
          durationSeconds: 100,
        },
        sender,
      ),
    ).resolves.toBe(false);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(stopped).resolves.toBe(true);
    expect(dispatcher.diagnostics).toMatchObject({
      acceptedUpdates: 1,
      requestAttempts: 2,
      successfulUpdates: 0,
      failedUpdates: 1,
      lastStatus: null,
      lastError: 'Error',
      lastErrorMessage: 'offline',
    });
    await expect(
      dispatcher.dispatch({ type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId }, sender),
    ).resolves.toBe(false);
  });

  it('恢复 Worker 会话绑定后仍校验页面 origin', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const dispatcher = new PlexTimelineDispatcher({ fetcher });
    dispatcher.restore(reportId, { ...sender, context }, Date.now());

    await expect(
      dispatcher.dispatch(
        {
          type: PLEX_TIMELINE_REPORT_MESSAGE,
          reportId,
          state: 'playing',
          timeSeconds: 10,
          durationSeconds: 100,
        },
        sender,
      ),
    ).resolves.toBe(true);
    await expect(
      dispatcher.dispatch(
        { type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId },
        { ...sender, pageOrigin: context.origin },
      ),
    ).resolves.toBe(false);
  });

  it('给挂起请求设置短超时且只重试一次', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timed out', 'AbortError')),
            { once: true },
          );
        });
      });
      const dispatcher = new PlexTimelineDispatcher({
        fetcher,
        requestTimeoutMilliseconds: 100,
      });
      dispatcher.register(reportId, { ...sender, context });

      const result = dispatcher.dispatch(
        {
          type: PLEX_TIMELINE_REPORT_MESSAGE,
          reportId,
          state: 'playing',
          timeSeconds: 10,
          durationSeconds: 100,
        },
        sender,
      );
      await vi.runAllTimersAsync();

      await expect(result).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(dispatcher.diagnostics).toMatchObject({
        requestAttempts: 2,
        successfulUpdates: 0,
        failedUpdates: 1,
        lastError: 'AbortError',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
