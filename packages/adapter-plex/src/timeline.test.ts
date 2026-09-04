import { describe, expect, it } from 'vitest';
import { createPlexTimelineRequest, parsePlexTimelineContext } from './timeline.js';

const startRequest =
  'https://plex.example:20600/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F109591&mediaIndex=0&partIndex=0&X-Plex-Token=private-token&X-Plex-Product=Plex%20Web&X-Plex-Version=4.160.0&X-Plex-Client-Identifier=client-1&X-Plex-Session-Identifier=playback-1';

describe('Plex timeline contract', () => {
  it('从建流请求提取后台专用认证上下文', () => {
    expect(parsePlexTimelineContext(startRequest)).toEqual({
      origin: 'https://plex.example:20600',
      metadataPath: '/library/metadata/109591',
      ratingKey: '109591',
      token: 'private-token',
      clientParameters: [
        ['X-Plex-Product', 'Plex Web'],
        ['X-Plex-Version', '4.160.0'],
        ['X-Plex-Client-Identifier', 'client-1'],
        ['X-Plex-Session-Identifier', 'playback-1'],
      ],
    });
  });

  it('构造不在 URL 暴露 Token 的最小状态请求', () => {
    const context = parsePlexTimelineContext(startRequest);
    if (!context) throw new Error('expected timeline context');
    const request = createPlexTimelineRequest(context, {
      state: 'playing',
      timeSeconds: 12.3456,
      durationSeconds: 100,
    });
    const url = new URL(request.url);

    expect(url.pathname).toBe('/:/timeline');
    expect(url.searchParams.get('ratingKey')).toBe('109591');
    expect(url.searchParams.get('key')).toBe('/library/metadata/109591');
    expect(url.searchParams.get('state')).toBe('playing');
    expect(url.searchParams.get('time')).toBe('12346');
    expect(url.searchParams.get('duration')).toBe('100000');
    expect(url.searchParams.has('X-Plex-Token')).toBe(false);
    expect(request.token).toBe('private-token');
  });

  it('拒绝缺少唯一 Token、非单集 metadata 或非法时间', () => {
    expect(
      parsePlexTimelineContext(
        'https://plex.example/video/:/transcode/universal/start.mpd?path=%2Flibrary%2Fmetadata%2F1',
      ),
    ).toBeUndefined();
    expect(parsePlexTimelineContext(`${startRequest}&X-Plex-Token=second`)).toBeUndefined();
    const context = parsePlexTimelineContext(startRequest);
    if (!context) throw new Error('expected timeline context');
    expect(() =>
      createPlexTimelineRequest(context, {
        state: 'paused',
        timeSeconds: -1,
        durationSeconds: 100,
      }),
    ).toThrow(RangeError);
  });
});
