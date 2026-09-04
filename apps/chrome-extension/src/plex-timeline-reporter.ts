import type { PlayerFrameEvent } from './player-frame-protocol.js';
import {
  PLEX_TIMELINE_RELEASE_MESSAGE,
  PLEX_TIMELINE_REPORT_MESSAGE,
  type PlexTimelineMessage,
} from './plex-timeline-protocol.js';

export interface PlexTimelineReporterOptions {
  reportId: string;
  send(message: PlexTimelineMessage): void;
  now?: () => number;
  intervalMilliseconds?: number;
}

/**
 * Plex 状态回写按固定墙钟周期节流；暂停、结束和关闭立即落点。媒体播放不等待任何回写结果。
 */
export class PlexTimelineReporter {
  private readonly reportId: string;
  private readonly send: (message: PlexTimelineMessage) => void;
  private readonly now: () => number;
  private readonly intervalMilliseconds: number;
  private currentTime = 0;
  private duration: number | undefined;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSentState: 'playing' | 'paused' | 'stopped' | undefined;
  private started = false;
  private released = false;

  constructor(options: PlexTimelineReporterOptions) {
    this.reportId = options.reportId;
    this.send = options.send;
    this.now = options.now ?? performance.now.bind(performance);
    this.intervalMilliseconds = options.intervalMilliseconds ?? 10_000;
    if (!Number.isFinite(this.intervalMilliseconds) || this.intervalMilliseconds <= 0) {
      throw new RangeError('intervalMilliseconds must be greater than zero');
    }
  }

  observe(event: PlayerFrameEvent): void {
    if (this.released) return;
    if (event.type === 'started') {
      this.updatePosition(this.currentTime, event.media.durationSeconds);
      return;
    }
    if (event.type === 'playing') {
      this.updatePosition(event.currentTime, event.duration);
      this.started = true;
      this.report('playing', true);
      return;
    }
    if (event.type === 'paused') {
      this.updatePosition(event.currentTime, event.duration);
      if (this.started) this.report('paused', true);
      return;
    }
    if (event.type === 'ended') {
      this.updatePosition(event.currentTime, event.duration);
      if (this.started) this.report('stopped', true, true);
      else this.release();
      return;
    }
    if (event.type !== 'time') return;
    this.updatePosition(event.currentTime, event.duration);
    if (event.paused || !this.started) return;
    this.report('playing', false);
  }

  close(): void {
    if (this.released) return;
    if (this.started && this.duration !== undefined) this.report('stopped', true, true);
    else this.release();
  }

  private updatePosition(currentTime: number, duration: number | null): void {
    if (Number.isFinite(currentTime) && currentTime >= 0) this.currentTime = currentTime;
    if (duration !== null && Number.isFinite(duration) && duration > 0) this.duration = duration;
  }

  private report(state: 'playing' | 'paused' | 'stopped', force: boolean, release = false): void {
    const duration = this.duration;
    if (duration === undefined) {
      if (release) this.release();
      return;
    }
    const now = this.now();
    if (
      !force &&
      this.lastSentState === state &&
      now - this.lastSentAt < this.intervalMilliseconds
    ) {
      return;
    }
    this.lastSentAt = now;
    this.lastSentState = state;
    this.send({
      type: PLEX_TIMELINE_REPORT_MESSAGE,
      reportId: this.reportId,
      state,
      timeSeconds: Math.min(this.currentTime, duration),
      durationSeconds: duration,
      ...(release ? { release: true } : {}),
    });
    if (release) this.released = true;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.send({ type: PLEX_TIMELINE_RELEASE_MESSAGE, reportId: this.reportId });
  }
}
