import type { AudioMediaTrack, MediaDescriptor } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import {
  expectedPlexErrorCode,
  formatAudioTrackLabel,
  formatMediaFormats,
  presentPlaybackFailure,
  presentPlexError,
} from './player-presentation.js';

describe('player presentation', () => {
  it('使用容器轨道事实生成可理解且不重复的音轨标签', () => {
    const track: AudioMediaTrack = {
      id: '2',
      kind: 'audio',
      codec: 'eac3',
      language: '中文',
      title: 'Dolby Digital Plus',
      channels: 2,
    };

    expect(formatAudioTrackLabel(track)).toBe('中文 · Dolby Digital Plus · EAC3 · 立体声');
  });

  it('把失效源地址归类为可操作提示且不暴露内部错误详情', () => {
    const error = Object.assign(
      new Error('RangeProtocolError.unexpected_status.status_403.secret_detail'),
      { name: 'MediaWorkerRemoteError', code: 'stream_failed' },
    );

    expect(presentPlaybackFailure(error)).toEqual({
      code: 'source_expired',
      message: '媒体地址已失效，自动刷新未成功，请关闭后重新播放。',
    });
  });

  it('区分格式不支持、缓冲不足和普通源站失败', () => {
    expect(presentPlaybackFailure(namedError('BrowserPlaybackUnsupportedError')).code).toBe(
      'media_format_error',
    );
    expect(presentPlaybackFailure(namedError('MseBufferQuotaExceededError')).code).toBe(
      'buffer_quota',
    );
    expect(
      presentPlaybackFailure(
        Object.assign(namedError('MediaWorkerRemoteError'), { code: 'stream_failed' }),
      ).code,
    ).toBe('media_read_failed');
  });

  it('按 Plex 错误码映射不同的人话说明', () => {
    expect(presentPlexError('s1002')?.message).toBe('无法读取媒体数据，请检查网络后重试');
    expect(presentPlexError('s3016')?.message).toBe('当前浏览器不支持此媒体的视频或音频格式');
    expect(presentPlexError('s4001')?.message).toBe('播放器无法读取媒体清单');
    expect(presentPlexError('s9999')).toBeUndefined();
    expect(expectedPlexErrorCode('media_format_error')).toBe('s3016');
    expect(expectedPlexErrorCode('media_probe_failed')).toBe('s4001');
  });

  it('只在存在真实媒体事实时附加视频与音频格式', () => {
    expect(
      presentPlexError('s3016', {
        video: 'Dolby Vision P5 / HEVC',
        audio: 'EAC3',
      }),
    ).toEqual({
      code: 's3016',
      message: '当前浏览器不支持此媒体的视频或音频格式，视频 Dolby Vision P5 / HEVC，音频 EAC3',
    });
    expect(presentPlexError('s1001', { video: 'HEVC' })?.message).toBe(
      '媒体请求被服务器拒绝，请稍后重试，视频 HEVC',
    );
  });

  it('区分信息不足、解码失败与格式不支持', () => {
    expect(presentPlaybackFailure(namedError('BrowserPlaybackProbeRequiredError')).code).toBe(
      'media_probe_failed',
    );
    expect(
      presentPlaybackFailure(Object.assign(namedError('BrowserMediaElementError'), { code: 3 }))
        .code,
    ).toBe('media_decode_error');
    expect(
      presentPlaybackFailure(Object.assign(namedError('BrowserMediaElementError'), { code: 4 }))
        .code,
    ).toBe('media_format_error');
  });

  it('从媒体事实生成不含源信息的视频与音频格式标签', () => {
    const descriptor: MediaDescriptor = {
      sourceId: 'private-source',
      container: 'mp4',
      tracks: [
        {
          id: '1',
          kind: 'video',
          codec: 'hevc',
          codecString: 'dvh1.05.06',
          hdr: { kind: 'dolby-vision', profile: 5, level: 6 },
        },
        {
          id: '2',
          kind: 'audio',
          codec: 'eac3',
          codecString: 'ec-3',
          isDefault: true,
        },
      ],
    };

    expect(formatMediaFormats(descriptor)).toEqual({
      video: 'Dolby Vision P5 / HEVC',
      audio: 'EAC3',
    });
  });

  it('将容器暴露的 DVH1 编码名称转换为可读格式', () => {
    expect(
      formatMediaFormats({
        sourceId: 'source',
        container: 'mp4',
        tracks: [{ id: '1', kind: 'video', codec: 'dvh1', codecString: 'dvh1' }],
      }),
    ).toEqual({ video: 'Dolby Vision / HEVC' });
  });

  it('将 Matroska 音频 Codec ID 转为用户可读格式', () => {
    expect(
      formatMediaFormats({
        sourceId: 'source',
        container: 'matroska',
        tracks: [{ id: '2', kind: 'audio', codec: 'a_truehd', isDefault: true }],
      }),
    ).toEqual({ audio: 'TrueHD' });
  });
});

const namedError = (name: string): Error => Object.assign(new Error('internal detail'), { name });
