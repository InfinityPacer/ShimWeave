import type { PlexTimelineState } from '@shimweave/adapter-plex';

export const PLEX_TIMELINE_REPORT_MESSAGE = 'shimweave:plex-timeline-report' as const;
export const PLEX_TIMELINE_RELEASE_MESSAGE = 'shimweave:plex-timeline-release' as const;

export interface PlexTimelineReportMessage {
  type: typeof PLEX_TIMELINE_REPORT_MESSAGE;
  reportId: string;
  state: PlexTimelineState;
  timeSeconds: number;
  durationSeconds: number;
  release?: boolean;
}

export interface PlexTimelineReleaseMessage {
  type: typeof PLEX_TIMELINE_RELEASE_MESSAGE;
  reportId: string;
}

export type PlexTimelineMessage = PlexTimelineReportMessage | PlexTimelineReleaseMessage;

export const isPlexTimelineMessage = (value: unknown): value is PlexTimelineMessage => {
  if (!isRecord(value) || !opaqueId(value.reportId)) return false;
  if (value.type === PLEX_TIMELINE_RELEASE_MESSAGE) return true;
  return (
    value.type === PLEX_TIMELINE_REPORT_MESSAGE &&
    (value.state === 'playing' || value.state === 'paused' || value.state === 'stopped') &&
    finiteNonNegativeNumber(value.timeSeconds) &&
    positiveFiniteNumber(value.durationSeconds) &&
    (value.release === undefined || typeof value.release === 'boolean')
  );
};

const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

const finiteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const positiveFiniteNumber = (value: unknown): value is number =>
  finiteNonNegativeNumber(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
