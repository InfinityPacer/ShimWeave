import { describe, expect, it, vi } from 'vitest';
import type { PlayerFrameEvent } from './player-frame-protocol.js';
import { PLAYER_FRAME_PROTOCOL } from './player-frame-protocol.js';
import {
  PLEX_TIMELINE_RELEASE_MESSAGE,
  PLEX_TIMELINE_REPORT_MESSAGE,
  type PlexTimelineMessage,
} from './plex-timeline-protocol.js';
import { PlexTimelineReporter } from './plex-timeline-reporter.js';

const nonce = 'frame-nonce';
const reportId = 'report_identifier_123456';

describe('Plex timeline reporter', () => {
  it('按墙钟节流播放进度并立即回写暂停和停止', () => {
    const sent: PlexTimelineMessage[] = [];
    let now = 0;
    const reporter = new PlexTimelineReporter({
      reportId,
      send: (message) => sent.push(message),
      now: () => now,
      intervalMilliseconds: 10_000,
    });

    reporter.observe(started(100));
    reporter.observe(state('playing', 10, 100));
    now = 5_000;
    reporter.observe(time(15, 100, false));
    now = 10_000;
    reporter.observe(time(20, 100, false));
    reporter.observe(state('paused', 21, 100));
    reporter.close();

    expect(sent).toEqual([
      report('playing', 10, 100),
      report('playing', 20, 100),
      report('paused', 21, 100),
      { ...report('stopped', 21, 100), release: true },
    ]);
  });

  it('未真正播放的会话只释放句柄', () => {
    const send = vi.fn();
    const reporter = new PlexTimelineReporter({ reportId, send });
    reporter.observe(started(100));
    reporter.close();

    expect(send).toHaveBeenCalledWith({ type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId });
  });

  it('播放结束只发送一次最终停止状态', () => {
    const sent: PlexTimelineMessage[] = [];
    const reporter = new PlexTimelineReporter({ reportId, send: (message) => sent.push(message) });
    reporter.observe(started(100));
    reporter.observe(state('playing', 90, 100));
    reporter.observe(state('ended', 100, 100));
    reporter.close();

    expect(sent.at(-1)).toEqual({ ...report('stopped', 100, 100), release: true });
    expect(sent.filter((message) => message.type === PLEX_TIMELINE_REPORT_MESSAGE)).toHaveLength(2);
  });
});

const started = (durationSeconds: number): PlayerFrameEvent => ({
  protocol: PLAYER_FRAME_PROTOCOL,
  type: 'started',
  nonce,
  strategy: 'remux',
  media: {
    container: 'matroska',
    durationSeconds,
    video: {
      codec: 'hevc',
      codecString: 'hvc1.2.4.L153.B0',
      width: 3840,
      height: 2160,
      hdrKind: 'hdr10',
      hdrProfile: null,
    },
    audio: { codec: 'aac', codecString: 'mp4a.40.2', channels: 2 },
  },
});

const state = (
  type: 'playing' | 'paused' | 'ended',
  currentTime: number,
  duration: number,
): PlayerFrameEvent => ({
  protocol: PLAYER_FRAME_PROTOCOL,
  type,
  nonce,
  currentTime,
  duration,
});

const time = (currentTime: number, duration: number, paused: boolean): PlayerFrameEvent => ({
  protocol: PLAYER_FRAME_PROTOCOL,
  type: 'time',
  nonce,
  currentTime,
  duration,
  paused,
});

const report = (
  stateValue: 'playing' | 'paused' | 'stopped',
  timeSeconds: number,
  durationSeconds: number,
): PlexTimelineMessage => ({
  type: PLEX_TIMELINE_REPORT_MESSAGE,
  reportId,
  state: stateValue,
  timeSeconds,
  durationSeconds,
});
