import type { MediaFormatPresentation } from './player-presentation.js';
import { expectedPlexErrorCode, presentPlexError } from './player-presentation.js';

interface PendingPlexError {
  readonly expectedCode?: string;
  readonly formats: MediaFormatPresentation;
  readonly expiresAt: number;
}

interface RememberedPlexError {
  readonly expectedCode?: string;
  readonly formats: MediaFormatPresentation;
}

export interface PlexErrorPresenterOptions {
  document: Document;
  now?: () => number;
  ttlMs?: number;
}

const DEFAULT_PRESENTATION_TTL_MS = 5_000;
const PLEX_ERROR_CODE_PATTERN = /\bs\d{4}\b/i;

/**
 * 只在 ShimWeave 播放失败后的短窗口内改写 Plex 原生错误正文。
 * 弹窗生命周期、按钮和错误码仍由 Plex 管理，未知错误码保持原样。
 */
export class PlexErrorPresenter {
  private readonly document: Document;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly observer: MutationObserver;
  private pending: PendingPlexError | undefined;
  private remembered: RememberedPlexError | undefined;
  private sourceKey: string | undefined;

  constructor(options: PlexErrorPresenterOptions) {
    this.document = options.document;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_PRESENTATION_TTL_MS;
    this.observer = new MutationObserver(() => this.apply());
    this.observer.observe(this.document, { childList: true, characterData: true, subtree: true });
  }

  arm(failureCode: string, formats: MediaFormatPresentation): void {
    const expectedCode = expectedPlexErrorCode(failureCode);
    const presentation = {
      ...(expectedCode ? { expectedCode } : {}),
      formats,
    };
    this.remembered = isDeterministicMediaFailure(failureCode) ? presentation : undefined;
    this.pending = {
      ...presentation,
      expiresAt: this.now() + this.ttlMs,
    };
    this.apply();
  }

  /** 确定性媒体失败可在同一 Part 的 Plex 内部重试中复用，切换媒体后必须立即失效。 */
  beginSource(sourceKey: string): void {
    if (this.sourceKey === sourceKey) {
      if (this.remembered) {
        this.pending = { ...this.remembered, expiresAt: this.now() + this.ttlMs };
        this.apply();
      }
      return;
    }
    this.sourceKey = sourceKey;
    this.pending = undefined;
    this.remembered = undefined;
  }

  dispose(): void {
    this.pending = undefined;
    this.remembered = undefined;
    this.sourceKey = undefined;
    this.observer.disconnect();
  }

  private apply(): void {
    const pending = this.pending;
    if (!pending) return;
    if (this.now() > pending.expiresAt) {
      this.pending = undefined;
      return;
    }
    for (const codeElement of this.document.querySelectorAll<HTMLElement>(
      '[class*="PlayerErrorModal-errorCode-"]',
    )) {
      const plexCode = codeElement.textContent?.match(PLEX_ERROR_CODE_PATTERN)?.[0];
      if (!plexCode) continue;
      if (pending.expectedCode && plexCode.toLowerCase() !== pending.expectedCode) continue;
      const presentation = presentPlexError(plexCode, pending.formats);
      const body = codeElement.parentElement;
      if (!presentation || !body) continue;
      const messageNode = Array.from(body.childNodes).find(
        (node) =>
          node !== codeElement && node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (!messageNode) continue;
      const messageText = `${presentation.message}。`;
      const codeText = `（错误代码：${presentation.code}）`;
      // MutationObserver 会观察到自身的文本写入；相同内容不得重复赋值，否则会形成微任务回路。
      if (messageNode.textContent !== messageText) messageNode.textContent = messageText;
      if (codeElement.textContent !== codeText) codeElement.textContent = codeText;
      this.pending = undefined;
      return;
    }
  }
}

const isDeterministicMediaFailure = (failureCode: string): boolean =>
  failureCode === 'media_decode_error' || failureCode === 'media_format_error';
