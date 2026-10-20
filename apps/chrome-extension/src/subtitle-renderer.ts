import type { SubtitleCue } from '@shimweave/contracts';

type CueConstructor = new (startTime: number, endTime: number, text: string) => VTTCue;

export interface TextTrackSubtitleRendererOptions {
  mediaElement: HTMLMediaElement;
  language?: string;
  /** 轨道名。内嵌字幕与外挂字幕各用一条轨道，切换时互不清掉对方的 cue。 */
  label?: string;
  /** 测试可注入；缺省使用页面的 VTTCue。 */
  createCue?: CueConstructor;
}

const DEFAULT_TRACK_LABEL = 'ShimWeave';
const STYLE_ATTRIBUTE = 'data-shimweave-subtitles';
/** 站点脚本关掉字幕轨时最多恢复这么多次，避免与站点反复争夺同一轨道。 */
const MAX_MODE_RESTORES = 8;

/** 同一个 video 每个轨道名只创建一条 TextTrack，addTextTrack 添加的轨道无法移除，停用后留给下次复用。 */
const tracksByElement = new WeakMap<HTMLMediaElement, Map<string, TextTrack>>();
/** 同一个 video 上未释放的渲染器数量，最后一个释放时才去掉字幕样式标记。 */
const renderersByElement = new WeakMap<HTMLMediaElement, number>();

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
  private visible = true;
  private disposed = false;

  constructor(options: TextTrackSubtitleRendererOptions) {
    this.mediaElement = options.mediaElement;
    this.createCue = options.createCue ?? globalThis.VTTCue;
    const label = options.label ?? DEFAULT_TRACK_LABEL;
    const tracks = tracksByElement.get(this.mediaElement) ?? new Map<string, TextTrack>();
    tracksByElement.set(this.mediaElement, tracks);
    this.track =
      tracks.get(label) ??
      this.mediaElement.addTextTrack('subtitles', label, options.language ?? '');
    tracks.set(label, this.track);
    renderersByElement.set(this.mediaElement, (renderersByElement.get(this.mediaElement) ?? 0) + 1);
    this.clearCues();
    // 同一个 video 上复用的轨道可能还留着上一次接管画出的字幕，先隐藏再显示让浏览器重画。
    this.repaint();
    this.mediaElement.setAttribute(STYLE_ATTRIBUTE, '');
    ensureCueStyle(this.mediaElement.ownerDocument);
    this.mediaElement.textTracks.addEventListener?.('change', this.onTracksChanged);
    this.mediaElement.addEventListener?.('seeked', this.onSeeked);
  }

  /** 新的播放代次开始：清掉上一代的 cue，只接受新一代从目标位置重建的字幕。 */
  reset(): void {
    if (this.disposed) return;
    this.clearCues();
    this.repaint();
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

  /** 播放中关掉或换走字幕时先隐藏，cue 保留，换回同一条字幕时立即恢复显示。 */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.track.mode = visible ? 'showing' : 'hidden';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mediaElement.textTracks.removeEventListener?.('change', this.onTracksChanged);
    this.mediaElement.removeEventListener?.('seeked', this.onSeeked);
    this.clearCues();
    this.track.mode = 'disabled';
    const remaining = (renderersByElement.get(this.mediaElement) ?? 1) - 1;
    if (remaining > 0) {
      renderersByElement.set(this.mediaElement, remaining);
      return;
    }
    renderersByElement.delete(this.mediaElement);
    this.mediaElement.removeAttribute(STYLE_ATTRIBUTE);
  }

  /**
   * Chrome 跳转之后不会撤下跳转前正在显示的 cue，即使它已不在 activeCues 里，画面上会同时
   * 留着两句字幕。切一次显示状态，浏览器按当前 activeCues 重画。
   */
  private repaint(): void {
    if (this.disposed || !this.visible) return;
    this.track.mode = 'hidden';
    this.track.mode = 'showing';
  }

  private readonly onSeeked = (): void => this.repaint();

  private readonly onTracksChanged = (): void => {
    if (this.disposed || !this.visible || this.track.mode === 'showing') return;
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
