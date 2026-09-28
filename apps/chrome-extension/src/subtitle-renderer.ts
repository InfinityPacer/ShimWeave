import type { SubtitleCue } from '@shimweave/contracts';

type CueConstructor = new (startTime: number, endTime: number, text: string) => VTTCue;

export interface TextTrackSubtitleRendererOptions {
  mediaElement: HTMLMediaElement;
  language?: string;
  /** 测试可注入；缺省使用页面的 VTTCue。 */
  createCue?: CueConstructor;
}

const TRACK_LABEL = 'ShimWeave';
const STYLE_ATTRIBUTE = 'data-shimweave-subtitles';
/** 站点脚本关掉字幕轨时最多恢复这么多次，避免与站点反复争夺同一轨道。 */
const MAX_MODE_RESTORES = 8;

/** 同一个 video 只创建一条 TextTrack，addTextTrack 添加的轨道无法移除，停用后留给下次复用。 */
const tracksByElement = new WeakMap<HTMLMediaElement, TextTrack>();

/**
 * 把字幕 cue 渲染为 video 自己的 TextTrack。cue 使用原媒体绝对时间，与 MSE 恢复后的
 * 页面时间一致；文本按 WebVTT cue 文本交给浏览器解析，不写入 DOM。
 */
export class TextTrackSubtitleRenderer {
  private readonly mediaElement: HTMLMediaElement;
  private readonly track: TextTrack;
  private readonly createCue: CueConstructor;
  private readonly seen = new Set<string>();
  private modeRestores = 0;
  private disposed = false;

  constructor(options: TextTrackSubtitleRendererOptions) {
    this.mediaElement = options.mediaElement;
    this.createCue = options.createCue ?? globalThis.VTTCue;
    const existing = tracksByElement.get(this.mediaElement);
    this.track =
      existing ?? this.mediaElement.addTextTrack('subtitles', TRACK_LABEL, options.language ?? '');
    tracksByElement.set(this.mediaElement, this.track);
    this.clearCues();
    this.track.mode = 'showing';
    this.mediaElement.setAttribute(STYLE_ATTRIBUTE, '');
    ensureCueStyle(this.mediaElement.ownerDocument);
    this.mediaElement.textTracks.addEventListener?.('change', this.onTracksChanged);
  }

  /** 新的播放代次开始：清掉上一代的 cue，只接受新一代从目标位置重建的字幕。 */
  reset(): void {
    if (this.disposed) return;
    this.clearCues();
  }

  add(cues: readonly SubtitleCue[]): void {
    if (this.disposed) return;
    for (const cue of cues) {
      const key = `${cue.startSeconds}:${cue.endSeconds}:${cue.text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const rendered = new this.createCue(cue.startSeconds, cue.endSeconds, cue.text);
      if (cue.placement === 'top') {
        rendered.snapToLines = true;
        rendered.line = 0;
      }
      this.track.addCue(rendered);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mediaElement.textTracks.removeEventListener?.('change', this.onTracksChanged);
    this.clearCues();
    this.track.mode = 'disabled';
    this.mediaElement.removeAttribute(STYLE_ATTRIBUTE);
  }

  private readonly onTracksChanged = (): void => {
    if (this.disposed || this.track.mode === 'showing') return;
    if (this.modeRestores >= MAX_MODE_RESTORES) return;
    this.modeRestores += 1;
    this.track.mode = 'showing';
  };

  private clearCues(): void {
    this.seen.clear();
    const cues = this.track.cues;
    if (!cues) return;
    for (const cue of Array.from(cues)) this.track.removeCue(cue);
  }
}

/**
 * 字幕样式只作用于正在显示 ShimWeave 字幕的 video：白字、无底色、描边阴影，
 * 字号沿用浏览器按画面高度计算的默认值。
 */
const ensureCueStyle = (document: Document): void => {
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = `video[${STYLE_ATTRIBUTE}]::cue {
  color: #fff;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  text-shadow: 0 0 4px #000, 0 0 2px #000, 1px 1px 2px #000;
  white-space: pre-line;
}`;
  (document.head ?? document.documentElement).append(style);
};
