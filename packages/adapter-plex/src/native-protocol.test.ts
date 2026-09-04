import { describe, expect, it } from 'vitest';
import { isPlexNativeMessage, PLEX_NATIVE_PROTOCOL } from './native-protocol.js';

describe('Plex native bridge protocol', () => {
  it('只接受字段闭合且不含媒体凭据的控制消息', () => {
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'extension-host',
        type: 'source-available',
        requestKey: 'plex:source:playback',
        sourceKey: 'plex:source',
        noticeId: 'notice_id_1234567890',
      }),
    ).toBe(true);
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'watcher-ready',
      }),
    ).toBe(true);
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'blocked-source-retry',
        sourceKey: 'plex:source',
      }),
    ).toBe(true);
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'takeover-start',
        requestKey: 'plex:source:playback',
        sessionId: 'native_session_1234567890',
        sourceUrl: 'https://cdn.example/private',
      }),
    ).toBe(false);
    for (const forbidden of ['token', 'bearer', 'authorization', 'cookie', 'url']) {
      expect(
        isPlexNativeMessage({
          protocol: PLEX_NATIVE_PROTOCOL,
          sender: 'extension-host',
          type: 'source-available',
          requestKey: 'plex:source:playback',
          sourceKey: 'plex:source',
          noticeId: 'notice_id_1234567890',
          [forbidden]: 'private-value',
        }),
      ).toBe(false);
    }
  });

  it('拒绝方向、会话和错误码不完整的消息', () => {
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'source-available',
        requestKey: 'request',
        sourceKey: 'source',
      }),
    ).toBe(false);
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'extension-host',
        type: 'takeover-ready',
        sessionId: 'short',
      }),
    ).toBe(false);
    expect(
      isPlexNativeMessage({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'blocked-source-retry',
        sourceKey: '',
      }),
    ).toBe(false);
  });
});
