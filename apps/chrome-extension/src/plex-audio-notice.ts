import type { AudioMediaTrack } from '@shimweave/contracts';
import { formatAudioShortLabel } from './player-presentation.js';

const VISIBLE_MS = 6_000;

/**
 * 音轨替换后在画面上方短暂提示一次。挂在全屏元素内，否则 Plex 全屏时看不到；
 * 不拦截点击，不影响 Plex 自己的控制栏。
 */
export class PlexAudioNotice {
  private readonly document: Document;
  private element: HTMLElement | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly top: string;

  /** top 用于让音轨与字幕两条提示同时出现时上下错开。 */
  constructor(document: Document, options: { top?: string } = {}) {
    this.document = document;
    this.top = options.top ?? '72px';
  }

  show(requested: AudioMediaTrack, playing: AudioMediaTrack): void {
    this.showText(
      `浏览器无法播放 ${formatAudioShortLabel(requested)}，已改用 ${formatAudioShortLabel(playing)}`,
      'audio',
    );
  }

  /** 同一位置只保留最新一条提示；文本走 textContent，不解析为 HTML。 */
  showText(text: string, kind: 'audio' | 'subtitle' | 'playback', visibleMs = VISIBLE_MS): void {
    this.dispose();
    const element = this.document.createElement('div');
    element.setAttribute('role', 'status');
    element.dataset.shimweaveNotice = kind;
    element.textContent = text;
    Object.assign(element.style, {
      position: 'fixed',
      top: this.top,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      maxWidth: 'min(640px, calc(100vw - 32px))',
      padding: '10px 16px',
      borderRadius: '8px',
      background: 'rgba(23, 23, 23, 0.88)',
      color: '#f3f0e8',
      font: '500 14px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif',
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
      pointerEvents: 'none',
      transition: 'opacity 240ms ease',
      opacity: '1',
    } satisfies Partial<CSSStyleDeclaration>);
    (this.document.fullscreenElement ?? this.document.body).append(element);
    this.element = element;
    this.timer = setTimeout(() => {
      element.style.opacity = '0';
      this.timer = setTimeout(() => this.dispose(), 300);
    }, visibleMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.element?.remove();
    this.element = undefined;
  }
}
