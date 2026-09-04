import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlexErrorPresenter } from './plex-error-presenter.js';

class TestMutationObserver {
  static callback: MutationCallback | undefined;

  constructor(callback: MutationCallback) {
    TestMutationObserver.callback = callback;
  }

  observe(): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] {
    return [];
  }

  static notify(): void {
    TestMutationObserver.callback?.([], {} as MutationObserver);
  }
}

class TestNode {
  static readonly TEXT_NODE = 3;
  readonly nodeType = 0;
}

afterEach(() => {
  TestMutationObserver.callback = undefined;
  vi.unstubAllGlobals();
});

describe('PlexErrorPresenter', () => {
  it('同一媒体的确定性失败重试继续展示真实格式，切换媒体后不复用', () => {
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('Node', TestNode);

    const messageNode = { nodeType: 3, textContent: '播放媒体时出现错误。' };
    const codeElement = {
      textContent: '错误代码：s3016',
      parentElement: { childNodes: [messageNode] },
    };
    let visible = false;
    const document = {
      querySelectorAll: () => (visible ? [codeElement] : []),
    } as unknown as Document;
    let now = 0;
    const presenter = new PlexErrorPresenter({ document, now: () => now, ttlMs: 5 });

    presenter.beginSource('source-a');
    presenter.arm('media_format_error', {
      video: 'Dolby Vision P5 / HEVC',
      audio: 'EAC3',
    });
    visible = true;
    TestMutationObserver.notify();

    expect(messageNode.textContent).toBe(
      '当前浏览器不支持此媒体的视频或音频格式，视频 Dolby Vision P5 / HEVC，音频 EAC3。',
    );
    expect(codeElement.textContent).toBe('（错误代码：s3016）');

    messageNode.textContent = '播放媒体时出现错误。';
    codeElement.textContent = '错误代码：s3016';
    now = 1_000;
    presenter.beginSource('source-a');
    TestMutationObserver.notify();
    expect(messageNode.textContent).toContain('Dolby Vision P5 / HEVC');

    presenter.beginSource('source-b');
    messageNode.textContent = '播放媒体时出现错误。';
    codeElement.textContent = '错误代码：s3016';
    TestMutationObserver.notify();
    expect(messageNode.textContent).toBe('播放媒体时出现错误。');

    presenter.dispose();
  });

  it('已呈现的确定性错误不会因 MutationObserver 重复通知而再次写入 DOM', () => {
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('Node', TestNode);

    let messageText = '播放媒体时出现错误。';
    let codeText = '错误代码：s3016';
    let messageWrites = 0;
    let codeWrites = 0;
    const messageNode = {
      nodeType: 3,
      get textContent() {
        return messageText;
      },
      set textContent(value: string | null) {
        messageWrites += 1;
        messageText = value ?? '';
      },
    };
    const codeElement = {
      get textContent() {
        return codeText;
      },
      set textContent(value: string | null) {
        codeWrites += 1;
        codeText = value ?? '';
      },
      parentElement: { childNodes: [messageNode] },
    };
    const document = {
      querySelectorAll: () => [codeElement],
    } as unknown as Document;
    const presenter = new PlexErrorPresenter({ document });

    presenter.beginSource('source-a');
    presenter.arm('media_format_error', { video: 'Dolby Vision P5 / HEVC', audio: 'EAC3' });
    expect({ messageWrites, codeWrites }).toEqual({ messageWrites: 1, codeWrites: 1 });

    TestMutationObserver.notify();
    TestMutationObserver.notify();
    expect({ messageWrites, codeWrites }).toEqual({ messageWrites: 1, codeWrites: 1 });

    presenter.dispose();
  });
});
