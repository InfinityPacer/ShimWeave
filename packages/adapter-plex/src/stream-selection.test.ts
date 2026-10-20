import type { MediaTrack } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPlexMetadataRequest,
  createPlexStreamFileRequest,
  isPlexSubtitleSelectionChange,
  parsePlexStreamSelection,
  plexSubtitleSelectionKey,
  resolvePlexAudioTrack,
  resolvePlexExternalSubtitle,
  resolvePlexSubtitleTrack,
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
      subtitle: { ordinal: 0, codec: 'pgs' },
    });
  });

  it('没有选中音轨或索引越界时返回空选择', () => {
    expect(parsePlexStreamSelection(metadata(blurayStreams), 0, 0).audio).toBeUndefined();
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

describe('Plex 字幕选择', () => {
  const part = (streams: readonly Record<string, unknown>[]) => ({
    MediaContainer: { Metadata: [{ Media: [{ Part: [{ Stream: streams }] }] }] },
  });
  const video = { id: 1, streamType: 1, codec: 'h264', index: 0 };
  const audio = { id: 2, streamType: 2, codec: 'aac', index: 1, selected: true };
  const subtitles = [
    { id: 12, streamType: 3, codec: 'pgs', index: 4 },
    { id: 10, streamType: 3, codec: 'srt', index: 2, languageTag: 'en' },
    { id: 11, streamType: 3, codec: 'ass', index: 3 },
  ];
  const engineTracks: MediaTrack[] = [
    { id: '1', kind: 'video', codec: 'h264' },
    { id: '2', kind: 'audio', codec: 'aac' },
    { id: '3', kind: 'subtitle', codec: 'srt' },
    { id: '4', kind: 'subtitle', codec: 'ass' },
    { id: '5', kind: 'subtitle', codec: 'pgs' },
  ];
  const select = (id: number) =>
    part([video, audio, ...subtitles.map((stream) => ({ ...stream, selected: stream.id === id }))]);

  it('按内嵌字幕的容器顺序定位选中字幕', () => {
    expect(parsePlexStreamSelection(select(10), 0, 0).subtitle).toEqual({
      ordinal: 0,
      codec: 'srt',
      language: 'en',
    });
    expect(parsePlexStreamSelection(select(12), 0, 0).subtitle).toEqual({
      ordinal: 2,
      codec: 'pgs',
    });
  });

  it('没有选字幕时不返回字幕选择，外挂字幕单独标记', () => {
    expect(parsePlexStreamSelection(select(0), 0, 0).subtitle).toBeUndefined();
    const external = part([
      video,
      ...subtitles,
      { id: 20, streamType: 3, codec: 'srt', key: '/library/streams/20', selected: true },
    ]);
    expect(parsePlexStreamSelection(external, 0, 0).subtitle).toEqual({
      external: true,
      key: '/library/streams/20',
      codec: 'srt',
    });
  });

  it('外挂字幕的地址只接受字幕文件的形状', () => {
    const external = (key: unknown) =>
      part([video, { id: 20, streamType: 3, codec: 'srt', key, selected: true }]);
    for (const key of ['/library/parts/20', '/library/streams/20?x=1', 'https://other/streams/1']) {
      expect(parsePlexStreamSelection(external(key), 0, 0).subtitle).toEqual({
        external: true,
        codec: 'srt',
      });
    }
  });

  it('外挂 SRT 与 WebVTT 由 ShimWeave 绘制，ASS 等格式提示不可用', () => {
    expect(
      resolvePlexExternalSubtitle({
        external: true,
        key: '/library/streams/20',
        codec: 'srt',
        language: 'zh',
      }),
    ).toEqual({ status: 'sidecar', key: '/library/streams/20', format: 'srt', language: 'zh' });
    expect(
      resolvePlexExternalSubtitle({ external: true, key: '/library/streams/21', codec: 'vtt' }),
    ).toEqual({ status: 'sidecar', key: '/library/streams/21', format: 'webvtt' });
    expect(
      resolvePlexExternalSubtitle({ external: true, key: '/library/streams/22', codec: 'ass' }),
    ).toEqual({ status: 'unavailable', reason: 'unsupported_codec', codec: 'ass' });
    expect(resolvePlexExternalSubtitle({ external: true, codec: 'srt' })).toEqual({
      status: 'unavailable',
      reason: 'external',
      codec: 'srt',
    });
  });

  it('选择标识区分关闭、外挂与内嵌字幕', () => {
    const keys = [
      plexSubtitleSelectionKey(undefined),
      plexSubtitleSelectionKey({ external: true, key: '/library/streams/20', codec: 'srt' }),
      plexSubtitleSelectionKey({ external: true, key: '/library/streams/21', codec: 'srt' }),
      plexSubtitleSelectionKey({ ordinal: 0, codec: 'srt' }),
      plexSubtitleSelectionKey({ ordinal: 1, codec: 'srt' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(plexSubtitleSelectionKey({ ordinal: 0, codec: 'srt', language: 'en' })).toBe(keys[3]);
  });

  it('字幕文件请求只在请求头里携带 Token，且只接受字幕文件地址', () => {
    const context = {
      origin: 'https://plex.example.test:32400',
      metadataPath: '/library/metadata/42',
      ratingKey: '42',
      token: 'secret-token',
      clientParameters: [['X-Plex-Client-Identifier', 'client-a']] as const,
    };
    const request = createPlexStreamFileRequest(context, '/library/streams/20');
    expect(request?.url).toBe(
      'https://plex.example.test:32400/library/streams/20?X-Plex-Client-Identifier=client-a',
    );
    expect(request?.url).not.toContain('secret-token');
    expect(request?.token).toBe('secret-token');
    expect(createPlexStreamFileRequest(context, '//other.test/library/streams/20')).toBeUndefined();
    expect(createPlexStreamFileRequest(context, '/library/metadata/42')).toBeUndefined();
  });

  it('只把记下字幕选择的 Part 请求当作换字幕', () => {
    const origin = 'https://plex.example.test:32400';
    expect(isPlexSubtitleSelectionChange(`${origin}/library/parts/7?subtitleStreamID=20`)).toBe(
      true,
    );
    expect(isPlexSubtitleSelectionChange(`${origin}/library/parts/7?subtitleStreamID=0`)).toBe(
      true,
    );
    expect(isPlexSubtitleSelectionChange(`${origin}/library/parts/7?audioStreamID=3`)).toBe(false);
    expect(isPlexSubtitleSelectionChange(`${origin}/library/parts/7/file.mkv`)).toBe(false);
    expect(isPlexSubtitleSelectionChange('not a url')).toBe(false);
  });

  it('位置与编码都对得上时对应到引擎字幕轨', () => {
    expect(resolvePlexSubtitleTrack(engineTracks, { ordinal: 0, codec: 'srt' })).toEqual({
      status: 'track',
      trackId: '3',
    });
    expect(resolvePlexSubtitleTrack(engineTracks, { ordinal: 0, codec: 'subrip' })).toEqual({
      status: 'track',
      trackId: '3',
    });
    expect(resolvePlexSubtitleTrack(engineTracks, { ordinal: 2, codec: 'pgs' })).toEqual({
      status: 'track',
      trackId: '5',
    });
  });

  it('未选字幕保持关闭，编码不符、越界或外挂字幕不猜测', () => {
    expect(resolvePlexSubtitleTrack(engineTracks, undefined)).toEqual({ status: 'off' });
    expect(resolvePlexSubtitleTrack(engineTracks, { ordinal: 1, codec: 'srt' })).toEqual({
      status: 'unavailable',
      reason: 'mismatch',
      codec: 'srt',
    });
    expect(resolvePlexSubtitleTrack(engineTracks, { ordinal: 3 })).toEqual({
      status: 'unavailable',
      reason: 'mismatch',
    });
    expect(resolvePlexSubtitleTrack(engineTracks, { external: true, codec: 'srt' })).toEqual({
      status: 'unavailable',
      reason: 'external',
      codec: 'srt',
    });
  });
});
