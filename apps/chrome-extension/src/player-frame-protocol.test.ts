import { describe, expect, it } from 'vitest';
import { isPlayerFrameEvent, PLAYER_FRAME_PROTOCOL } from './player-frame-protocol.js';

const nonce = 'frame-nonce';

describe('player frame protocol', () => {
  it('接受带媒体摘要的播放开始事件', () => {
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'started',
          nonce,
          strategy: 'native',
          media: {
            container: 'matroska',
            durationSeconds: 1492,
            video: {
              codec: 'hevc',
              codecString: 'hvc1.2.4.L153.B0',
              width: 3840,
              height: 2160,
              hdrKind: 'hdr10',
              hdrProfile: null,
            },
            audio: { codec: 'eac3', codecString: 'ec-3', channels: 2 },
          },
        },
        nonce,
      ),
    ).toBe(true);
  });

  it('拒绝错误 nonce、策略和时间指标', () => {
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'playing',
          nonce: 'other',
          currentTime: 1,
          duration: 10,
        },
        nonce,
      ),
    ).toBe(false);
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'started',
          nonce,
          strategy: 'transcode-video',
          media: { container: 'mkv', video: { codec: 'hevc' }, audio: null },
        },
        nonce,
      ),
    ).toBe(false);
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'time',
          nonce,
          currentTime: 4,
          duration: 10,
          paused: false,
          decodedVideoFrames: -1,
        },
        nonce,
      ),
    ).toBe(false);
  });

  it('只接受带安全时间值的播放状态事件', () => {
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'paused',
          nonce,
          currentTime: 12,
          duration: 100,
        },
        nonce,
      ),
    ).toBe(true);
    expect(
      isPlayerFrameEvent(
        {
          protocol: PLAYER_FRAME_PROTOCOL,
          type: 'ended',
          nonce,
          currentTime: Number.NaN,
          duration: 100,
        },
        nonce,
      ),
    ).toBe(false);
  });
});
