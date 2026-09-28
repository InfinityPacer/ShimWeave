import type { MediaTrack } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPlexMetadataRequest,
  parsePlexStreamSelection,
  resolvePlexAudioTrack,
} from './stream-selection.js';

// 字段取自 Plex Media Server 1.43 `/library/metadata/{id}` 的 JSON 响应，去掉了无关字段。
const metadata = (streams: readonly Record<string, unknown>[]) => ({
  MediaContainer: {
    Metadata: [
      {
        Media: [
          {
            Part: [
              {
                Stream: [
                  { id: 1, streamType: 1, codec: 'hevc', index: 0 },
                  ...streams,
                  { id: 9, streamType: 3, codec: 'pgs', index: 5, selected: true },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

const blurayStreams = [
  { id: 4, streamType: 2, codec: 'ac3', index: 4, languageTag: 'en', languageCode: 'eng' },
  { id: 2, streamType: 2, codec: 'truehd', index: 1, languageTag: 'en', languageCode: 'eng' },
  { id: 3, streamType: 2, codec: 'ac3', index: 3, languageTag: 'zh', languageCode: 'zho' },
  { id: 5, streamType: 2, codec: 'ac3', index: 2, languageTag: 'en', languageCode: 'eng' },
];

const tracks: MediaTrack[] = [
  { id: '1', kind: 'video', codec: 'hevc' },
  { id: '2', kind: 'audio', codec: 'a_truehd', language: 'eng' },
  { id: '3', kind: 'audio', codec: 'ac3', language: 'eng' },
  { id: '4', kind: 'audio', codec: 'ac3', language: 'chi' },
  { id: '5', kind: 'audio', codec: 'ac3', language: 'eng' },
  { id: '6', kind: 'subtitle', codec: 'pgs' },
];

describe('Plex 音轨选择', () => {
  it('按容器顺序定位选中音轨，不受响应中的排列顺序影响', () => {
    const body = metadata(
      blurayStreams.map((stream) => (stream.id === 3 ? { ...stream, selected: true } : stream)),
    );

    expect(parsePlexStreamSelection(body, 0, 0)).toEqual({
      audio: { ordinal: 2, codec: 'ac3', language: 'zh' },
    });
  });

  it('没有选中音轨或索引越界时返回空选择', () => {
    expect(parsePlexStreamSelection(metadata(blurayStreams), 0, 0)).toEqual({});
    expect(parsePlexStreamSelection(metadata(blurayStreams), 1, 0)).toEqual({});
    expect(parsePlexStreamSelection({ MediaContainer: {} }, 0, 0)).toEqual({});
    expect(parsePlexStreamSelection('not json', 0, 0)).toEqual({});
  });

  it('选择对应到媒体引擎的音轨，编码命名差异按同一编码处理', () => {
    expect(resolvePlexAudioTrack(tracks, { ordinal: 0, codec: 'truehd' })).toBe('2');
    expect(resolvePlexAudioTrack(tracks, { ordinal: 2, codec: 'ac3' })).toBe('4');
    expect(
      resolvePlexAudioTrack([{ id: '7', kind: 'audio', codec: 'dts' }], {
        ordinal: 0,
        codec: 'dca',
      }),
    ).toBe('7');
  });

  it('位置对得上但编码不同或越界时不猜测', () => {
    expect(resolvePlexAudioTrack(tracks, { ordinal: 0, codec: 'ac3' })).toBeUndefined();
    expect(resolvePlexAudioTrack(tracks, { ordinal: 4 })).toBeUndefined();
    expect(resolvePlexAudioTrack(tracks, undefined)).toBeUndefined();
  });

  it('元数据请求只在请求头里携带 Token', () => {
    const request = createPlexMetadataRequest({
      origin: 'https://plex.example.test:32400',
      metadataPath: '/library/metadata/42',
      ratingKey: '42',
      token: 'secret-token',
      clientParameters: [['X-Plex-Client-Identifier', 'client-a']],
    });

    expect(request.url).toBe(
      'https://plex.example.test:32400/library/metadata/42?X-Plex-Client-Identifier=client-a',
    );
    expect(request.url).not.toContain('secret-token');
    expect(request.token).toBe('secret-token');
  });
});
