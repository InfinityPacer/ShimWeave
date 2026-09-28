import type {
  AudioMediaTrack,
  MediaDescriptor,
  SubtitleUnavailableReason,
  VideoMediaTrack,
} from '@shimweave/contracts';

export interface PlaybackFailurePresentation {
  code: string;
  message: string;
}

export interface MediaFormatPresentation {
  video?: string;
  audio?: string;
}

export interface PlexErrorPresentation {
  code: string;
  message: string;
}

export const expectedPlexErrorCode = (failureCode: string): string | undefined =>
  PLEX_CODE_BY_FAILURE[failureCode];

/** 播放器只展示稳定错误类别，Worker 内部异常和源站地址不得进入用户界面。 */
export const presentPlaybackFailure = (error: unknown): PlaybackFailurePresentation => {
  const name = errorName(error);
  const remoteCode = recordString(error, 'code');
  const detail = error instanceof Error ? error.message : '';

  if (name === 'BrowserPlaybackProbeRequiredError') {
    return {
      code: 'media_probe_failed',
      message: '媒体信息不足，无法确定可用的播放路径。',
    };
  }
  if (name === 'BrowserMediaElementError') {
    const mediaErrorCode = recordNumber(error, 'code');
    if (mediaErrorCode === 3) {
      return {
        code: 'media_decode_error',
        message: '浏览器无法解码此媒体。',
      };
    }
    if (mediaErrorCode === 4) {
      return {
        code: 'media_format_error',
        message: '当前浏览器不支持此媒体格式。',
      };
    }
    return {
      code: 'media_read_failed',
      message: '浏览器无法读取媒体数据，请稍后重试。',
    };
  }
  if (name === 'BrowserPlaybackUnsupportedError' || name === 'MseTypeUnsupportedError') {
    return {
      code: 'media_format_error',
      message: '当前浏览器不支持此媒体格式。',
    };
  }
  if (name === 'MseSourceBufferError') {
    return {
      code: 'media_decode_error',
      message: '浏览器无法处理此媒体数据。',
    };
  }
  if (name === 'MseBufferQuotaExceededError') {
    return {
      code: 'buffer_quota',
      message: '浏览器缓冲空间不足，请关闭其他媒体标签页后重试。',
    };
  }
  if (name === 'MseSeekTargetUnavailableError') {
    return {
      code: 'seek_unavailable',
      message: '无法定位到指定播放位置，请从较早位置重新播放。',
    };
  }
  if (name === 'MediaWorkerRemoteError' && detail.includes('status_403')) {
    return {
      code: 'source_expired',
      message: '媒体地址已失效，自动刷新未成功，请关闭后重新播放。',
    };
  }
  if (name === 'MediaWorkerRemoteError' && remoteCode === 'probe_failed') {
    return {
      code: 'media_probe_failed',
      message: '无法读取媒体信息，请稍后重试。',
    };
  }
  if (name === 'MediaWorkerRemoteError') {
    return {
      code: 'media_read_failed',
      message: '媒体源暂时不可用，请稍后重试。',
    };
  }
  return {
    code: 'playback_failed',
    message: '播放未能继续，请关闭后重新播放。',
  };
};

/** Plex 错误码与用户说明保持一对一；未知错误码沿用站点原文。 */
export const presentPlexError = (
  plexCode: string,
  formats: MediaFormatPresentation = {},
): PlexErrorPresentation | undefined => {
  const message = PLEX_ERROR_MESSAGES[plexCode.toLowerCase()];
  if (!message) return undefined;
  const formatDetails = [
    formats.video ? `视频 ${formats.video}` : undefined,
    formats.audio ? `音频 ${formats.audio}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    code: plexCode.toLowerCase(),
    message: formatDetails.length === 0 ? message : `${message}，${formatDetails.join('，')}`,
  };
};

/** 音轨标签优先保留语言和标题，再补充格式与声道，避免依赖站点私有 ID。 */
export const formatAudioTrackLabel = (track: AudioMediaTrack): string => {
  const identity = uniqueText([track.language, track.title]);
  const technical = uniqueText([
    formatAudioCodec(track.codec),
    track.channels ? formatChannels(track.channels) : undefined,
  ]);
  return [...identity, ...technical].join(' · ');
};

/** 替换提示用的短标签，例如「TrueHD 6 声道 · 英语」，语言按浏览器界面语言显示。 */
export const formatAudioShortLabel = (track: AudioMediaTrack, locale = 'zh-CN'): string => {
  const technical = [
    formatAudioCodec(track.codec),
    track.channels ? formatChannels(track.channels) : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const language = displayLanguage(track.language, locale);
  return language ? `${technical} · ${language}` : technical;
};

const displayLanguage = (code: string | undefined, locale: string): string | undefined => {
  if (!code || code === 'und') return undefined;
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** 字幕不可用提示只说明原因类别，不暴露轨道编号或文件信息。 */
export const formatSubtitleUnavailable = (
  reason: SubtitleUnavailableReason,
  codec?: string,
): string => {
  if (reason === 'unsupported_codec') {
    const label = codec ? SUBTITLE_CODEC_LABELS[codec.toLowerCase()] : undefined;
    return label ? `字幕没有显示，暂不支持 ${label}` : '字幕没有显示，暂不支持这种字幕格式';
  }
  if (reason === 'external') return '字幕没有显示，暂不支持外挂字幕';
  if (reason === 'mismatch' || reason === 'track_not_found') {
    return '字幕没有显示，无法确认所选字幕对应文件里的哪一条';
  }
  if (reason === 'unsupported_encoding') return '字幕没有显示，字幕数据使用了暂不支持的编码';
  if (reason === 'no_index') return '字幕没有显示，文件缺少索引，从中途播放时无法定位字幕';
  return '字幕没有显示，读取字幕失败';
};

const SUBTITLE_CODEC_LABELS: Readonly<Record<string, string>> = {
  pgs: 'PGS 图形字幕',
  hdmv_pgs_subtitle: 'PGS 图形字幕',
  vobsub: 'VobSub 图形字幕',
  dvd_subtitle: 'VobSub 图形字幕',
  dvb_subtitle: 'DVB 图形字幕',
  ass: 'ASS 字幕',
  ssa: 'SSA 字幕',
};

/** 页面错误提示只使用媒体结构事实，不暴露源地址、文件名或内部轨道标识。 */
export const formatMediaFormats = (descriptor: MediaDescriptor): MediaFormatPresentation => {
  const video = descriptor.tracks.find((track): track is VideoMediaTrack => track.kind === 'video');
  const audio =
    descriptor.tracks.find(
      (track): track is AudioMediaTrack => track.kind === 'audio' && track.isDefault === true,
    ) ?? descriptor.tracks.find((track): track is AudioMediaTrack => track.kind === 'audio');
  return {
    ...(video ? { video: formatVideoCodec(video) } : {}),
    ...(audio ? { audio: formatAudioCodec(audio.codec) } : {}),
  };
};

const formatVideoCodec = (track: VideoMediaTrack): string => {
  const normalizedCodec = track.codec.toLowerCase();
  const codec =
    normalizedCodec === 'dvh1' || normalizedCodec === 'dvhe' ? 'HEVC' : track.codec.toUpperCase();
  const dolbyVisionProfile =
    track.hdr?.kind === 'dolby-vision'
      ? track.hdr.profile
      : parseDolbyVisionProfile(track.codecString ?? track.codec);
  if (
    track.hdr?.kind === 'dolby-vision' ||
    normalizedCodec === 'dvh1' ||
    normalizedCodec === 'dvhe' ||
    track.codecString?.toLowerCase().startsWith('dvh1') ||
    track.codecString?.toLowerCase().startsWith('dvhe')
  ) {
    const profile = dolbyVisionProfile === undefined ? '' : ` P${dolbyVisionProfile}`;
    return `Dolby Vision${profile} / ${codec}`;
  }
  if (track.hdr?.kind === 'hdr10') return `HDR10 / ${codec}`;
  if (track.hdr?.kind === 'hdr10-plus') return `HDR10+ / ${codec}`;
  if (track.hdr?.kind === 'hlg') return `HLG / ${codec}`;
  if (track.profile === 'main-10') return `${codec} Main 10`;
  return codec;
};

const parseDolbyVisionProfile = (codecString: string): number | undefined => {
  const profile = codecString.toLowerCase().match(/^(?:dvh1|dvhe)\.0*(\d{1,2})(?:\.|$)/)?.[1];
  if (!profile) return undefined;
  const value = Number.parseInt(profile, 10);
  return Number.isFinite(value) ? value : undefined;
};

/** 容器内部 Codec ID 转为用户可识别的格式名，规划器仍保留原始媒体事实。 */
const formatAudioCodec = (codec: string): string => {
  const normalized = codec.trim().toLowerCase();
  if (normalized === 'a_truehd' || normalized === 'mlp fba') return 'TrueHD';
  if (normalized === 'a_eac3' || normalized === 'e-ac-3') return 'EAC3';
  if (normalized === 'a_ac3' || normalized === 'ac-3') return 'AC3';
  if (normalized.startsWith('a_dts')) return 'DTS';
  return codec.toUpperCase();
};

const formatChannels = (channels: number): string => {
  if (channels === 1) return '单声道';
  if (channels === 2) return '立体声';
  if (channels === 6) return '5.1 声道';
  if (channels === 8) return '7.1 声道';
  return `${channels} 声道`;
};

const uniqueText = (values: readonly (string | undefined)[]): string[] => [
  ...new Set(
    values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
  ),
];

const errorName = (error: unknown): string => (error instanceof Error ? error.name : '');

const recordString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
};

const recordNumber = (value: unknown, key: string): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' ? candidate : undefined;
};

const PLEX_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  s1001: '媒体请求被服务器拒绝，请稍后重试',
  s1002: '无法读取媒体数据，请检查网络后重试',
  s3016: '当前浏览器不支持此媒体的视频或音频格式',
  s3017: '浏览器缓冲空间不足，请关闭其他媒体标签页后重试',
  s4001: '播放器无法读取媒体清单',
};

const PLEX_CODE_BY_FAILURE: Readonly<Record<string, string>> = {
  source_expired: 's1002',
  media_read_failed: 's1002',
  media_decode_error: 's3016',
  media_format_error: 's3016',
  buffer_quota: 's3017',
  media_probe_failed: 's4001',
};
