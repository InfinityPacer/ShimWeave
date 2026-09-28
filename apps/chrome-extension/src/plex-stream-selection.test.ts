import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlexStreamSelection,
  isPlexStreamSelectionMessage,
  PLEX_STREAM_SELECTION_MESSAGE,
} from './plex-stream-selection.js';

const context = {
  origin: 'https://plex.example.test:32400',
  metadataPath: '/library/metadata/42',
  ratingKey: '42',
  token: 'secret-token',
  clientParameters: [],
};

const body = {
  MediaContainer: {
    Metadata: [
      {
        Media: [
          {
            Part: [
              {
                Stream: [
                  { streamType: 2, index: 1, codec: 'truehd' },
                  { streamType: 2, index: 2, codec: 'ac3', selected: true, languageTag: 'en' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('Plex 音轨选择消息', () => {
  it('只接受带播放会话句柄和非负位置的消息', () => {
    const valid = {
      type: PLEX_STREAM_SELECTION_MESSAGE,
      reportId: 'report_id_1234567890',
      mediaIndex: 0,
      partIndex: 0,
    };
    expect(isPlexStreamSelectionMessage(valid)).toBe(true);
    expect(isPlexStreamSelectionMessage({ ...valid, reportId: 'short' })).toBe(false);
    expect(isPlexStreamSelectionMessage({ ...valid, mediaIndex: -1 })).toBe(false);
    expect(isPlexStreamSelectionMessage({ ...valid, partIndex: 1.5 })).toBe(false);
  });

  it('后台用请求头携带 Token 读取元数据并返回选择', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

    const selection = await fetchPlexStreamSelection(context, 0, 0, fetcher as typeof fetch);

    expect(selection).toEqual({ audio: { ordinal: 1, codec: 'ac3', language: 'en' } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-token');
    expect(init.headers).toMatchObject({ 'X-Plex-Token': 'secret-token' });
    expect(init.credentials).toBe('omit');
  });

  it('请求失败或响应异常时返回空选择', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    });
    const denied = vi.fn(async () => new Response('', { status: 401 }));
    const garbage = vi.fn(async () => new Response('not json', { status: 200 }));

    expect(await fetchPlexStreamSelection(context, 0, 0, failing as typeof fetch)).toEqual({});
    expect(await fetchPlexStreamSelection(context, 0, 0, denied as typeof fetch)).toEqual({});
    expect(await fetchPlexStreamSelection(context, 0, 0, garbage as typeof fetch)).toEqual({});
  });
});
