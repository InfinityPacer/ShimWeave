export type PlexTimelineState = 'playing' | 'paused' | 'stopped';

export interface PlexTimelineContext {
  origin: string;
  metadataPath: string;
  ratingKey: string;
  token: string;
  clientParameters: readonly (readonly [string, string])[];
}

export interface PlexTimelineUpdate {
  state: PlexTimelineState;
  timeSeconds: number;
  durationSeconds: number;
}

export interface PlexTimelineRequest {
  url: string;
  token: string;
}

const CLIENT_PARAMETER_NAMES = [
  'X-Plex-Product',
  'X-Plex-Version',
  'X-Plex-Client-Identifier',
  'X-Plex-Platform',
  'X-Plex-Platform-Version',
  'X-Plex-Features',
  'X-Plex-Model',
  'X-Plex-Device',
  'X-Plex-Device-Name',
  'X-Plex-Device-Screen-Resolution',
  'X-Plex-Language',
  'X-Plex-Session-Id',
  'X-Plex-Session-Identifier',
] as const;

/**
 * 状态回写上下文只从已经获准播放的 Plex 建流请求提取。Token 单独保存，不能进入回写 URL、
 * 页面消息或持久存储。
 */
export const parsePlexTimelineContext = (requestUrl: string): PlexTimelineContext | undefined => {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (
    (request.protocol !== 'http:' && request.protocol !== 'https:') ||
    request.pathname !== '/video/:/transcode/universal/start.mpd'
  ) {
    return undefined;
  }
  const metadataPath = request.searchParams.get('path');
  const ratingKey = metadataPath?.match(/^\/library\/metadata\/([^/?#]+)$/)?.[1];
  const token = singleNonEmptyQueryValue(request, 'X-Plex-Token');
  if (!metadataPath || !ratingKey || !token) return undefined;

  const clientParameters: Array<readonly [string, string]> = [];
  for (const name of CLIENT_PARAMETER_NAMES) {
    const value = singleNonEmptyQueryValue(request, name);
    if (value !== undefined) clientParameters.push([name, value]);
  }
  return {
    origin: request.origin,
    metadataPath,
    ratingKey,
    token,
    clientParameters,
  };
};

/** 构造与 Plex Web 原生 timeline 等价的最小请求，认证信息只通过请求头发送。 */
export const createPlexTimelineRequest = (
  context: PlexTimelineContext,
  update: PlexTimelineUpdate,
): PlexTimelineRequest => {
  validateUpdate(update);
  const url = new URL('/:/timeline', context.origin);
  url.searchParams.set('ratingKey', context.ratingKey);
  url.searchParams.set('key', context.metadataPath);
  url.searchParams.set('playbackTime', '0');
  url.searchParams.set('state', update.state);
  url.searchParams.set(
    'time',
    String(Math.min(toMilliseconds(update.timeSeconds), toMilliseconds(update.durationSeconds))),
  );
  url.searchParams.set('duration', String(toMilliseconds(update.durationSeconds)));
  for (const [name, value] of context.clientParameters) url.searchParams.set(name, value);
  return { url: url.href, token: context.token };
};

const singleNonEmptyQueryValue = (request: URL, name: string): string | undefined => {
  const values = request.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]?.trim()) return undefined;
  return values[0];
};

const validateUpdate = (update: PlexTimelineUpdate): void => {
  if (!['playing', 'paused', 'stopped'].includes(update.state)) {
    throw new TypeError('Unsupported Plex timeline state');
  }
  if (!Number.isFinite(update.timeSeconds) || update.timeSeconds < 0) {
    throw new RangeError('timeSeconds must be a non-negative finite number');
  }
  if (!Number.isFinite(update.durationSeconds) || update.durationSeconds <= 0) {
    throw new RangeError('durationSeconds must be a positive finite number');
  }
};

const toMilliseconds = (seconds: number): number => Math.round(seconds * 1000);
