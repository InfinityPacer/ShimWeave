import {
  PLEX_NATIVE_PROTOCOL,
  type PlexMediaSourceNotice,
  type PlexNativeMessage,
  type PlexRequestStartedNotice,
  type PlexStreamSelection,
  type PlexSubtitleSelection,
  plexSubtitleSelectionKey,
  resolvePlexAudioTrack,
  resolvePlexExternalSubtitle,
  resolvePlexSubtitleTrack,
} from '@shimweave/adapter-plex';
import type {
  AudioFallbackPolicy,
  AudioMediaTrack,
  SubtitleCue,
  SubtitleUnavailableReason,
} from '@shimweave/contracts';
import { randomId } from '@shimweave/contracts';
import { MediaWorkerRemoteError } from './media-worker-client.js';
import { MseMediaDetachedError } from './mse-controller.js';
import type { ActiveBrowserPlayback, BrowserPlaybackRequest } from './playback-runtime.js';
import type { PlayerFrameEvent } from './player-frame-protocol.js';
import { PLAYER_FRAME_PROTOCOL } from './player-frame-protocol.js';
import {
  formatMediaFormats,
  type MediaFormatPresentation,
  type PlaybackFailurePresentation,
  presentPlaybackFailure,
} from './player-presentation.js';
import { parseSidecarSubtitles } from './sidecar-subtitles.js';
import { TextTrackSubtitleRenderer } from './subtitle-renderer.js';

interface PlaybackRuntimePort {
  start(request: BrowserPlaybackRequest): Promise<ActiveBrowserPlayback>;
  stop(): Promise<void>;
}

interface TimelineReporterPort {
  observe(event: PlayerFrameEvent): void;
  close(): void;
}

interface SidecarRendererPort {
  add(cues: readonly SubtitleCue[]): void;
  dispose(): void;
}

export interface PlexNativePlaybackHostOptions {
  createPlaybackRuntime(): PlaybackRuntimePort;
  resolveMediaElement(sessionId: string): HTMLMediaElement | undefined;
  postMessage(message: PlexNativeMessage): void;
  readStartSeconds(): number | undefined;
  createTimelineReporter?(notice: PlexMediaSourceNotice): TimelineReporterPort | undefined;
  releaseNotice?(notice: PlexMediaSourceNotice): void;
  presentFailure?(failure: PlaybackFailurePresentation, formats: MediaFormatPresentation): void;
  /** 读取 Plex 为当前用户记住的音轨选择；失败时返回空选择，不能阻断起播。 */
  resolveStreamSelection?(notice: PlexMediaSourceNotice): Promise<PlexStreamSelection>;
  readAudioFallback?(): Promise<AudioFallbackPolicy>;
  presentAudioSubstitution?(requested: AudioMediaTrack, playing: AudioMediaTrack): void;
  /** Plex 里选了字幕但无法显示时提示一次，视频照常播放。 */
  presentSubtitleUnavailable?(reason: SubtitleUnavailableReason, codec?: string): void;
  /**
   * 读取外挂字幕文件（`/library/streams/{id}`）的文本，由后台带会话凭据读取；
   * 失败时返回 undefined，页面提示字幕不可用。
   */
  readSubtitleFile?(notice: PlexMediaSourceNotice, key: string): Promise<string | undefined>;
  createSidecarRenderer?(
    mediaElement: HTMLMediaElement,
    language: string | undefined,
  ): SidecarRendererPort;
  /**
   * 接管就绪后播放中断时提示。此时 Plex 的加载早已完成，不会弹出自己的错误框，
   * 不提示的话画面只会停在缓冲状态。
   */
  presentInterruption?(failure: PlaybackFailurePresentation): void;
  createNoticeId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  sourceTtlMs?: number;
}

interface NativePlaybackSession {
  readonly generation: number;
  readonly sessionId: string;
  readonly notice: PlexMediaSourceNotice;
  readonly mediaElement: HTMLMediaElement;
  readonly reporter?: TimelineReporterPort;
  readonly removeMediaListeners: () => void;
  playback?: ActiveBrowserPlayback;
  descriptor?: ActiveBrowserPlayback['descriptor'];
  /** 当前按哪条 Plex 字幕选择显示，见 plexSubtitleSelectionKey。 */
  subtitleKey: string;
  /** 每次改变显示的字幕加一，迟到的外挂字幕读取据此作废。 */
  subtitleRevision: number;
  /** 每次重新读取选择加一，只采用最后一次读取的结果。 */
  selectionReads: number;
  /** 起播完成之前收到换字幕通知，起播后再读一次选择。 */
  selectionStale: boolean;
  sidecar?: SidecarRendererPort;
}

interface PendingNativeSource {
  readonly noticeId: string;
  /**
   * 同一播放请求被 Plex 重复发出时，旧通知已经交给页面，页面可能正用旧 noticeId 发起接管。
   * 新通知替换旧通知但保留旧 ID，接管按同一请求处理，不因通知更替失败。
   */
  readonly earlierNoticeIds: readonly string[];
  readonly notice: PlexMediaSourceNotice;
  readonly startSeconds?: number;
  timeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SOURCE_TTL_MS = 5_000;
const SIDECAR_TRACK_LABEL = 'ShimWeave sidecar';

/**
 * 会话结束原因写在 video 的 data-shimweave-session-end 上：失败为稳定错误码，
 * Hook 或新接管停止为 stopped，播完为 ended。只含错误类别，供现场排查读取。
 */
const SESSION_END_KEY = 'shimweaveSessionEnd';
/** 失败时另记异常类别链，例如 Worker 回传的 RangeProtocolError.http_status.status_403。 */
const SESSION_END_DETAIL_KEY = 'shimweaveSessionEndDetail';

const markSessionEnd = (session: NativePlaybackSession, reason: string, error?: unknown): void => {
  const dataset = session.mediaElement.dataset;
  dataset[SESSION_END_KEY] = reason;
  if (error === undefined) delete dataset[SESSION_END_DETAIL_KEY];
  else dataset[SESSION_END_DETAIL_KEY] = failureDetail(error);
};

/**
 * 只保留错误名、Worker 已脱敏的类别串和媒体错误码，并再次限制字符集，
 * 地址、令牌与自由文本不会写进页面。
 */
const failureDetail = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  const parts = [error.name];
  if (error instanceof MediaWorkerRemoteError) parts.push(error.code, error.message);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') parts.push(String(code));
  return parts
    .join(' ')
    .replace(/[^A-Za-z0-9_.> -]/g, '')
    .slice(0, 200);
};

/**
 * 隔离世界 Host 只在 MAIN Hook 已认领同一请求后启动媒体运行时。
 * 媒体地址和凭据不会跨入页面世界，未被认领的 Plex 响应不创建 Worker。
 */
export class PlexNativePlaybackHost {
  private readonly options: PlexNativePlaybackHostOptions;
  private readonly createNoticeId: () => string;
  private readonly schedule: NonNullable<PlexNativePlaybackHostOptions['schedule']>;
  private readonly cancelSchedule: NonNullable<PlexNativePlaybackHostOptions['cancelSchedule']>;
  private readonly sourceTtlMs: number;
  private readonly createSidecarRenderer: NonNullable<
    PlexNativePlaybackHostOptions['createSidecarRenderer']
  >;
  private readonly sources = new Map<string, PendingNativeSource>();
  private latestRequestId: string | undefined;
  private latestRequestKey: string | undefined;
  private runtime: PlaybackRuntimePort | undefined;
  private active: NativePlaybackSession | undefined;
  private generation = 0;
  private disposed = false;

  constructor(options: PlexNativePlaybackHostOptions) {
    this.options = options;
    this.createNoticeId = options.createNoticeId ?? randomId;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.sourceTtlMs = options.sourceTtlMs ?? DEFAULT_SOURCE_TTL_MS;
    this.createSidecarRenderer =
      options.createSidecarRenderer ??
      ((mediaElement, language) =>
        new TextTrackSubtitleRenderer({
          mediaElement,
          label: SIDECAR_TRACK_LABEL,
          ...(language ? { language } : {}),
        }));
  }

  /**
   * Plex Web 在播放器里换了字幕或关掉字幕。接管中的播放不会因此重新起播，这里重新读取
   * Plex 记下的选择：外挂 SRT 立即换上或撤下，内嵌字幕隐藏或恢复。
   */
  acceptSubtitleChanged(): void {
    const session = this.active;
    if (this.disposed || !session) return;
    if (!session.playback) {
      session.selectionStale = true;
      return;
    }
    void this.refreshSubtitles(session);
  }

  acceptRuntimeMessage(message: PlexRequestStartedNotice | PlexMediaSourceNotice): void {
    if (this.disposed) return;
    if (message.type === 'shimweave:plex-request-started') {
      this.latestRequestId = message.requestId;
      this.latestRequestKey = message.requestKey;
      for (const [requestKey, source] of this.sources) {
        if (requestKey === message.requestKey) continue;
        this.releaseSource(requestKey, source);
      }
      return;
    }
    if (
      message.requestId !== this.latestRequestId ||
      message.requestKey !== this.latestRequestKey
    ) {
      this.options.releaseNotice?.(message);
      return;
    }
    const previous = this.sources.get(message.requestKey);
    if (previous?.notice.requestId === message.requestId) {
      this.options.releaseNotice?.(message);
      return;
    }
    if (previous && previous.notice !== message) {
      this.sources.delete(message.requestKey);
      this.clearSourceTimeout(previous);
      this.options.releaseNotice?.(previous.notice);
    }
    const startSeconds = this.options.readStartSeconds();
    const source: PendingNativeSource = {
      noticeId: this.createNoticeId(),
      earlierNoticeIds: previous ? [previous.noticeId, ...previous.earlierNoticeIds] : [],
      notice: message,
      ...(startSeconds !== undefined ? { startSeconds } : {}),
    };
    source.timeout = this.schedule(() => {
      if (this.sources.get(message.requestKey) === source) {
        this.releaseSource(message.requestKey, source);
      }
    }, this.sourceTtlMs);
    this.sources.set(message.requestKey, source);
    this.options.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'source-available',
      requestKey: message.requestKey,
      sourceKey: message.sourceKey,
      noticeId: source.noticeId,
    });
  }

  acceptPageMessage(message: PlexNativeMessage): void {
    if (this.disposed || message.sender !== 'main-hook') return;
    if (message.type === 'takeover-start') {
      void this.startTakeover(message.requestKey, message.noticeId, message.sessionId);
      return;
    }
    if (message.type === 'source-rejected') {
      const source = this.sources.get(message.requestKey);
      if (source?.noticeId === message.noticeId) this.releaseSource(message.requestKey, source);
      return;
    }
    if (message.type === 'takeover-stop') {
      void this.stopSession(message.sessionId).finally(() => {
        this.options.postMessage({
          protocol: PLEX_NATIVE_PROTOCOL,
          sender: 'extension-host',
          type: 'takeover-stopped',
          sessionId: message.sessionId,
        });
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const [requestKey, source] of this.sources) this.releaseSource(requestKey, source);
    this.sources.clear();
    await this.stopActive();
  }

  private async startTakeover(
    requestKey: string,
    noticeId: string,
    sessionId: string,
  ): Promise<void> {
    const source = this.sources.get(requestKey);
    if (!source || (source.noticeId !== noticeId && !source.earlierNoticeIds.includes(noticeId))) {
      this.postTakeoverError(sessionId, 'source_unavailable');
      return;
    }
    this.sources.delete(requestKey);
    this.clearSourceTimeout(source);
    const { notice, startSeconds } = source;
    let mediaElement: HTMLMediaElement | undefined;
    let reporter: TimelineReporterPort | undefined;
    try {
      mediaElement = this.options.resolveMediaElement(sessionId);
      if (!mediaElement) {
        this.options.releaseNotice?.(notice);
        this.postTakeoverError(sessionId, 'media_element_unavailable');
        return;
      }
      reporter = this.options.createTimelineReporter?.(notice);
      await this.stopActive();
    } catch (error) {
      this.options.releaseNotice?.(notice);
      this.postTakeoverError(sessionId, presentPlaybackFailure(error).code);
      return;
    }
    if (this.disposed) {
      this.options.releaseNotice?.(notice);
      reporter?.close();
      return;
    }
    const generation = ++this.generation;
    delete mediaElement.dataset[SESSION_END_KEY];
    delete mediaElement.dataset[SESSION_END_DETAIL_KEY];
    const session: NativePlaybackSession = {
      generation,
      sessionId,
      notice,
      mediaElement,
      ...(reporter ? { reporter } : {}),
      removeMediaListeners: attachTimelineListeners(mediaElement, sessionId, reporter),
      subtitleKey: 'off',
      subtitleRevision: 0,
      selectionReads: 0,
      selectionStale: false,
    };
    this.active = session;

    try {
      const noSelection: PlexStreamSelection = {};
      const [selection, audioFallback] = await Promise.all([
        this.options.resolveStreamSelection?.(notice).catch(() => noSelection) ?? noSelection,
        this.options.readAudioFallback?.().catch((): AudioFallbackPolicy => 'strict') ??
          ('strict' as AudioFallbackPolicy),
      ]);
      if (this.active !== session || this.disposed) return;
      const subtitle = selection.subtitle;
      // 外挂字幕不在媒体文件里，起播后由宿主读取文件自己绘制，媒体运行时按不选字幕播放。
      const embeddedSubtitle = subtitle && !isExternalSubtitle(subtitle) ? subtitle : undefined;
      session.subtitleKey = plexSubtitleSelectionKey(subtitle);
      const playback = await this.getRuntime().start({
        source: notice.source,
        mediaElement,
        ...(selection.audio
          ? {
              selectAudioTrack: (descriptor) =>
                resolvePlexAudioTrack(descriptor.tracks, selection.audio),
            }
          : {}),
        audioFallback,
        // 未选字幕时字幕保持关闭；选了但对应不上时提示不可用，不猜测其他字幕。
        ...(embeddedSubtitle
          ? {
              selectSubtitleTrack: (descriptor) => {
                const resolved = resolvePlexSubtitleTrack(descriptor.tracks, embeddedSubtitle);
                if (resolved.status === 'track') return { trackId: resolved.trackId };
                if (resolved.status === 'off') return undefined;
                return {
                  unavailable: resolved.reason,
                  ...(resolved.codec ? { codec: resolved.codec } : {}),
                };
              },
              onSubtitleUnavailable: (reason, codec) => {
                if (this.active !== session) return;
                this.options.presentSubtitleUnavailable?.(reason, codec);
              },
            }
          : {}),
        ...(startSeconds !== undefined ? { startSeconds } : {}),
        onDescriptor: (descriptor) => {
          if (this.active !== session) return;
          session.descriptor = descriptor;
        },
        onPlan: (plan, descriptor) => {
          if (this.active !== session) return;
          this.presentSubstitution(plan, descriptor);
        },
      });
      if (this.active !== session || session.generation !== this.generation || this.disposed) {
        await playback.stop();
        return;
      }
      session.playback = playback;
      session.descriptor = playback.descriptor;
      observeTimelineSnapshot(session, playback.descriptor.durationSeconds);
      this.options.postMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'extension-host',
        type: 'takeover-ready',
        sessionId,
      });
      if (session.selectionStale) {
        session.selectionStale = false;
        void this.refreshSubtitles(session);
      } else if (subtitle && isExternalSubtitle(subtitle)) {
        void this.showExternalSubtitle(session, subtitle, session.subtitleRevision);
      }
      void playback.completion.then(
        () => {
          if (this.active === session) markSessionEnd(session, 'ended');
        },
        (error: unknown) => {
          if (this.active !== session) return;
          void this.failSession(session, error);
        },
      );
    } catch (error) {
      if (this.active !== session) return;
      await this.failSession(session, error);
    }
  }

  private async refreshSubtitles(session: NativePlaybackSession): Promise<void> {
    const read = ++session.selectionReads;
    const selection: PlexStreamSelection = await (
      this.options.resolveStreamSelection?.(session.notice) ??
      Promise.resolve<PlexStreamSelection>({ readFailed: true })
    ).catch((): PlexStreamSelection => ({ readFailed: true }));
    if (this.active !== session || read !== session.selectionReads || selection.readFailed) {
      return;
    }
    this.applySubtitle(session, selection.subtitle);
  }

  private applySubtitle(
    session: NativePlaybackSession,
    subtitle: PlexSubtitleSelection | undefined,
  ): void {
    const key = plexSubtitleSelectionKey(subtitle);
    if (key === session.subtitleKey) return;
    session.subtitleKey = key;
    const revision = ++session.subtitleRevision;
    session.sidecar?.dispose();
    delete session.sidecar;

    const embedded = subtitle && !isExternalSubtitle(subtitle) ? subtitle : undefined;
    const streamingTrackId = session.playback?.plan.subtitleTrackId;
    const descriptor = session.descriptor;
    const resolved =
      embedded && descriptor ? resolvePlexSubtitleTrack(descriptor.tracks, embedded) : undefined;
    const showsStreamed =
      resolved?.status === 'track' &&
      streamingTrackId !== undefined &&
      resolved.trackId === streamingTrackId;
    session.playback?.setSubtitlesVisible?.(showsStreamed);
    // 换到这次没有在读的内嵌字幕时只撤下旧字幕。Plex Web 随后以新选择重新起播会话，
    // 新的接管按新选择读取内嵌字幕，是否可用也由那次起播提示。
    if (!subtitle || showsStreamed || embedded) return;
    void this.showExternalSubtitle(session, subtitle, revision);
  }

  /** 读取外挂字幕文件并绘制。ASS 等格式与读取失败都只提示不可用，视频照常播放。 */
  private async showExternalSubtitle(
    session: NativePlaybackSession,
    subtitle: PlexSubtitleSelection,
    revision: number,
  ): Promise<void> {
    const current = () => this.active === session && session.subtitleRevision === revision;
    const resolved = resolvePlexExternalSubtitle(subtitle);
    if (resolved.status === 'unavailable') {
      this.options.presentSubtitleUnavailable?.(resolved.reason, resolved.codec);
      return;
    }
    const text = await (
      this.options.readSubtitleFile?.(session.notice, resolved.key) ?? Promise.resolve(undefined)
    ).catch(() => undefined);
    if (!current()) return;
    const cues = text === undefined ? [] : parseSidecarSubtitles(text, resolved.format);
    if (cues.length === 0) {
      this.options.presentSubtitleUnavailable?.('read_failed');
      return;
    }
    const renderer = this.createSidecarRenderer(session.mediaElement, resolved.language);
    renderer.add(cues);
    session.sidecar = renderer;
  }

  private presentSubstitution(
    plan: ActiveBrowserPlayback['plan'],
    descriptor: ActiveBrowserPlayback['descriptor'],
  ): void {
    const requestedId = plan.audioSubstitution?.requestedTrackId;
    if (!requestedId || !this.options.presentAudioSubstitution) return;
    const audio = (id: string | undefined) =>
      descriptor.tracks.find(
        (track): track is AudioMediaTrack => track.kind === 'audio' && track.id === id,
      );
    const requested = audio(requestedId);
    const playing = audio(plan.audioTrackId);
    if (requested && playing) this.options.presentAudioSubstitution(requested, playing);
  }

  private async failSession(session: NativePlaybackSession, error: unknown): Promise<void> {
    if (this.active !== session) return;
    // 用户在 Plex 里结束播放时站点先卸载 video，随后才可能发来 takeover-stop，按正常结束收尾，
    // 只通知 Hook 释放会话，否则同一媒体再次 load 会复用已结束的接管。
    if (error instanceof MseMediaDetachedError) {
      await this.stopActive('detached');
      this.postTakeoverError(session.sessionId, 'media_detached');
      return;
    }
    const failure = presentPlaybackFailure(error);
    const formats = session.descriptor ? formatMediaFormats(session.descriptor) : {};
    const interrupted = session.playback !== undefined;
    await this.stopActive(failure.code, error);
    this.options.presentFailure?.(failure, formats);
    if (interrupted) this.options.presentInterruption?.(failure);
    this.postTakeoverError(session.sessionId, failure.code);
  }

  private async stopSession(sessionId: string): Promise<void> {
    if (this.active?.sessionId !== sessionId) return;
    await this.stopActive();
  }

  private async stopActive(reason = 'stopped', error?: unknown): Promise<void> {
    const active = this.active;
    if (!active) return;
    markSessionEnd(active, reason, error);
    this.active = undefined;
    this.generation += 1;
    active.subtitleRevision += 1;
    active.sidecar?.dispose();
    delete active.sidecar;
    active.removeMediaListeners();
    active.reporter?.close();
    await this.runtime?.stop().catch(() => undefined);
  }

  private getRuntime(): PlaybackRuntimePort {
    this.runtime ??= this.options.createPlaybackRuntime();
    return this.runtime;
  }

  private postTakeoverError(sessionId: string, code: string): void {
    this.options.postMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'takeover-error',
      sessionId,
      code,
    });
  }

  private releaseSource(requestKey: string, source: PendingNativeSource): void {
    if (this.sources.get(requestKey) === source) this.sources.delete(requestKey);
    this.clearSourceTimeout(source);
    this.options.releaseNotice?.(source.notice);
  }

  private clearSourceTimeout(source: PendingNativeSource): void {
    if (!source.timeout) return;
    this.cancelSchedule(source.timeout);
    delete source.timeout;
  }
}

const isExternalSubtitle = (subtitle: PlexSubtitleSelection): boolean =>
  subtitle.external === true || subtitle.ordinal === undefined;

const attachTimelineListeners = (
  mediaElement: HTMLMediaElement,
  sessionId: string,
  reporter: TimelineReporterPort | undefined,
): (() => void) => {
  if (!reporter) return () => undefined;
  const observeState = (type: 'playing' | 'paused' | 'ended'): void => {
    reporter.observe({
      protocol: PLAYER_FRAME_PROTOCOL,
      type,
      nonce: sessionId,
      currentTime: finiteMediaTime(mediaElement.currentTime) ?? 0,
      duration: finiteMediaDuration(mediaElement.duration),
    });
  };
  const onPlaying = (): void => observeState('playing');
  const onPause = (): void => {
    if (!mediaElement.ended) observeState('paused');
  };
  const onEnded = (): void => observeState('ended');
  const onTimeUpdate = (): void => {
    reporter.observe({
      protocol: PLAYER_FRAME_PROTOCOL,
      type: 'time',
      nonce: sessionId,
      currentTime: finiteMediaTime(mediaElement.currentTime) ?? 0,
      duration: finiteMediaDuration(mediaElement.duration),
      paused: mediaElement.paused,
    });
  };
  mediaElement.addEventListener('playing', onPlaying);
  mediaElement.addEventListener('pause', onPause);
  mediaElement.addEventListener('ended', onEnded);
  mediaElement.addEventListener('timeupdate', onTimeUpdate);
  return () => {
    mediaElement.removeEventListener('playing', onPlaying);
    mediaElement.removeEventListener('pause', onPause);
    mediaElement.removeEventListener('ended', onEnded);
    mediaElement.removeEventListener('timeupdate', onTimeUpdate);
  };
};

const observeTimelineSnapshot = (
  session: NativePlaybackSession,
  descriptorDuration: number | undefined,
): void => {
  session.reporter?.observe({
    protocol: PLAYER_FRAME_PROTOCOL,
    type: 'time',
    nonce: session.sessionId,
    currentTime: finiteMediaTime(session.mediaElement.currentTime) ?? 0,
    duration:
      finiteMediaDuration(descriptorDuration) ?? finiteMediaDuration(session.mediaElement.duration),
    paused: session.mediaElement.paused,
  });
};

const finiteMediaTime = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 ? value : undefined;

const finiteMediaDuration = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
