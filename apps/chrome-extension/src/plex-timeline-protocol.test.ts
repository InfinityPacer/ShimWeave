import { describe, expect, it } from 'vitest';
import {
  isPlexTimelineMessage,
  PLEX_TIMELINE_RELEASE_MESSAGE,
  PLEX_TIMELINE_REPORT_MESSAGE,
} from './plex-timeline-protocol.js';

const reportId = 'report_identifier_123456';

describe('Plex timeline message protocol', () => {
  it('接受安全的状态与释放消息', () => {
    expect(
      isPlexTimelineMessage({
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'playing',
        timeSeconds: 12,
        durationSeconds: 100,
      }),
    ).toBe(true);
    expect(isPlexTimelineMessage({ type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId })).toBe(true);
  });

  it('拒绝非法句柄、状态和时间', () => {
    expect(
      isPlexTimelineMessage({
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId: 'short',
        state: 'playing',
        timeSeconds: 12,
        durationSeconds: 100,
      }),
    ).toBe(false);
    expect(
      isPlexTimelineMessage({
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'buffering',
        timeSeconds: 12,
        durationSeconds: 100,
      }),
    ).toBe(false);
    expect(
      isPlexTimelineMessage({
        type: PLEX_TIMELINE_REPORT_MESSAGE,
        reportId,
        state: 'paused',
        timeSeconds: Number.NaN,
        durationSeconds: 100,
      }),
    ).toBe(false);
  });
});
