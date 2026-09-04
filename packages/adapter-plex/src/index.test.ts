import { describe, expect, it } from 'vitest';
import {
  isPlexMediaSourceNotice,
  isPlexRequestStartedNotice,
  PLEX_MEDIA_SOURCE_MESSAGE,
  PLEX_REQUEST_STARTED_MESSAGE,
  parsePlexControlResponse,
  parsePlexMediaRedirect,
  parsePlexMediaSourceResponse,
  parsePlexRequestStarted,
  parsePlexTimelineSeconds,
} from './index.js';

describe('Plex media redirect adapter', () => {
  it('把 STRM start.mpd 302 转成稳定播放意图', () => {
    const result = parsePlexMediaRedirect(
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F109591&mediaIndex=0&partIndex=2&session=play-attempt&X-Plex-Session-Id=web-session&X-Plex-Token=private',
      'https://media.example/redirect/pickcode/file.mkv?sign=short-lived',
      'request-1',
    );

    expect(result).toEqual({
      type: PLEX_MEDIA_SOURCE_MESSAGE,
      source: {
        sourceId: 'plex:https://plex.example:/library/metadata/109591:0:2',
        access: {
          kind: 'direct-http-range',
          url: 'https://media.example/redirect/pickcode/file.mkv?sign=short-lived',
        },
        nativePlaybackUrl: 'https://media.example/redirect/pickcode/file.mkv?sign=short-lived',
      },
      metadataPath: '/library/metadata/109591',
      mediaIndex: 0,
      partIndex: 2,
      requestId: 'request-1',
      sourceKey: 'plex:https://plex.example:/library/metadata/109591:0:2',
      requestKey: 'plex:https://plex.example:/library/metadata/109591:0:2:web-session',
    });
    expect(result?.source.sourceId).not.toContain('private');
    expect(result && isPlexMediaSourceNotice(result)).toBe(true);
  });

  it('把 Gateway control-v1 响应转成媒体身份和控制能力', () => {
    const result = parsePlexControlResponse(
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F109591&mediaIndex=0&partIndex=2&X-Plex-Token=private',
      204,
      [
        { name: 'X-ShimWeave-Protocol', value: 'control-v1' },
        { name: 'X-ShimWeave-Source-Id', value: 'source_identity_1234567890' },
        { name: 'X-ShimWeave-Control-Url', value: '/_shimweave/control/v1/range' },
        { name: 'X-ShimWeave-Control-Token', value: 'control_token_12345678901234567890' },
      ],
      'request-2',
    );

    expect(result).toEqual({
      type: PLEX_MEDIA_SOURCE_MESSAGE,
      source: {
        sourceId: 'source_identity_1234567890',
        access: {
          kind: 'controlled-http-range',
          url: 'https://plex.example/_shimweave/control/v1/range',
          requestHeaders: {
            'X-ShimWeave-Control-Token': 'control_token_12345678901234567890',
          },
          responseUrlHeader: 'X-ShimWeave-Media-Url',
          expectedStatus: 204,
        },
      },
      metadataPath: '/library/metadata/109591',
      mediaIndex: 0,
      partIndex: 2,
      requestId: 'request-2',
      sourceKey: 'plex:https://plex.example:/library/metadata/109591:0:2',
      requestKey: 'plex:https://plex.example:/library/metadata/109591:0:2:unscoped',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('拒绝跨源、非固定控制路径和不完整的 control-v1 响应', () => {
    const request =
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0';
    const baseHeaders = [
      { name: 'X-ShimWeave-Protocol', value: 'control-v1' },
      { name: 'X-ShimWeave-Source-Id', value: 'source_identity_1234567890' },
      { name: 'X-ShimWeave-Control-Token', value: 'control_token_12345678901234567890' },
    ];
    expect(
      parsePlexControlResponse(
        request,
        204,
        [...baseHeaders, { name: 'X-ShimWeave-Control-Url', value: 'https://other.example/range' }],
        'request-3',
      ),
    ).toBeUndefined();
    expect(
      parsePlexControlResponse(
        request,
        204,
        [...baseHeaders, { name: 'X-ShimWeave-Control-Url', value: '/not-control' }],
        'request-3',
      ),
    ).toBeUndefined();
    expect(parsePlexControlResponse(request, 204, baseHeaders, 'request-3')).toBeUndefined();
  });

  it('为每个 Plex start.mpd 产生不含 Token 的请求关联身份', () => {
    const result = parsePlexRequestStarted(
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0&X-Plex-Playback-Session-Id=playback&X-Plex-Token=private',
      'request-4',
    );
    expect(result).toEqual({
      type: PLEX_REQUEST_STARTED_MESSAGE,
      requestId: 'request-4',
      sourceKey: 'plex:https://plex.example:/library/metadata/1:0:0',
      requestKey: 'plex:https://plex.example:/library/metadata/1:0:0:playback',
    });
    expect(result && isPlexRequestStartedNotice(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('把同一 Part 的 Direct Stream 与 Transcode 回退聚合为一个播放源', () => {
    const base =
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0';
    const target = 'https://media.example/file.mkv';

    const directStream = parsePlexMediaRedirect(
      `${base}&session=direct-stream&directStream=1`,
      target,
      'request-5',
    );
    const transcodeFallback = parsePlexMediaRedirect(
      `${base}&session=transcode&directStream=0`,
      `${target}?retry=1`,
      'request-6',
    );

    expect(transcodeFallback?.source.sourceId).toBe(directStream?.source.sourceId);
    expect(transcodeFallback?.sourceKey).toBe(directStream?.sourceKey);
    expect(transcodeFallback?.requestKey).not.toBe(directStream?.requestKey);
  });

  it('多个 provider 同时认领时完整回退 Plex', () => {
    const request =
      'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0';
    const duplicateProvider = {
      id: 'duplicate',
      resolve: () => ({
        sourceId: 'duplicate-source',
        access: { kind: 'direct-http-range' as const, url: 'https://media.example/file.mkv' },
      }),
    };
    expect(
      parsePlexMediaSourceResponse(
        request,
        { kind: 'redirect', redirectUrl: 'https://media.example/file.mkv' },
        'request-conflict',
        [
          {
            id: 'first',
            resolve: () => ({
              sourceId: 'first-source',
              access: {
                kind: 'direct-http-range' as const,
                url: 'https://media.example/file.mkv',
              },
            }),
          },
          duplicateProvider,
        ],
      ),
    ).toBeUndefined();
  });

  it('把 Plex 毫秒时间轴转换为安全的播放秒数', () => {
    expect(parsePlexTimelineSeconds('973000', '1492000')).toBe(973);
    expect(parsePlexTimelineSeconds('0', '1492000')).toBe(0);
    expect(parsePlexTimelineSeconds('1492001', '1492000')).toBeUndefined();
    expect(parsePlexTimelineSeconds('invalid', '1492000')).toBeUndefined();
  });

  it('忽略本地 manifest、非媒体重定向和不完整索引', () => {
    expect(
      parsePlexControlResponse(
        'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0',
        200,
        [{ name: 'Content-Type', value: 'application/dash+xml' }],
        'request-local-mpd',
      ),
    ).toBeUndefined();
    expect(
      parsePlexMediaRedirect(
        'https://plex.example/video/:/transcode/universal/start.m3u8?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0&partIndex=0',
        'https://cdn.example/video',
        'request-7',
      ),
    ).toBeUndefined();
    expect(
      parsePlexMediaRedirect(
        'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1&mediaIndex=0',
        'https://cdn.example/video',
        'request-8',
      ),
    ).toBeUndefined();
    expect(
      isPlexMediaSourceNotice({
        type: PLEX_MEDIA_SOURCE_MESSAGE,
        source: {
          sourceId: 'source',
          access: {
            kind: 'controlled-http-range',
            url: 'file:///media',
            requestHeaders: {
              'X-ShimWeave-Control-Token': 'control_token_12345678901234567890',
            },
            responseUrlHeader: 'X-ShimWeave-Media-Url',
          },
        },
        metadataPath: '/library/metadata/1',
        mediaIndex: 0,
        partIndex: 0,
        requestId: 'request',
        sourceKey: 'source-key',
        requestKey: 'request-key',
      }),
    ).toBe(false);
  });

  it('原生 Direct Play 的 Part 请求不进入媒体源 provider', () => {
    expect(
      parsePlexMediaSourceResponse(
        'https://plex.example/library/parts/123/456/file.mkv',
        { kind: 'redirect', redirectUrl: 'https://media.example/file.mkv' },
        'request-native-part',
      ),
    ).toBeUndefined();
  });
});
