import type {
  MediaSourceDescriptor,
  MediaSourceProvider,
  SiteAdapterManifest,
} from '@shimweave/contracts';
import { isMediaSourceDescriptor } from '@shimweave/contracts';
import { resolveMediaSource } from '@shimweave/core';
import { type PlexStartRequestIdentity, parsePlexStartRequest } from './request-identity.js';

export * from './native-hook.js';
export * from './native-protocol.js';
export * from './request-identity.js';
export * from './shaka-runtime-watcher.js';

export {
  createPlexTimelineRequest,
  type PlexTimelineContext,
  type PlexTimelineRequest,
  type PlexTimelineState,
  type PlexTimelineUpdate,
  parsePlexTimelineContext,
} from './timeline.js';

/** Plex 适配器只声明接入范围；媒体能力由核心运行时根据真实轨道决定。 */
export const plexAdapterManifest: SiteAdapterManifest = {
  id: 'plex',
  displayName: 'Plex Web',
  matchPatterns: ['http://*/web/*', 'https://*/web/*'],
};

export const PLEX_MEDIA_SOURCE_MESSAGE = 'shimweave:plex-media-source' as const;
export const PLEX_REQUEST_STARTED_MESSAGE = 'shimweave:plex-request-started' as const;

export interface PlexMediaSourceNotice {
  type: typeof PLEX_MEDIA_SOURCE_MESSAGE;
  source: MediaSourceDescriptor;
  metadataPath: string;
  mediaIndex: number;
  partIndex: number;
  /** Chrome 为一次网络请求分配的身份，用于拒绝迟到的旧播放响应。 */
  requestId: string;
  /** 不含播放会话的 Plex Media/Part 身份，用于合并同一源的建流回退。 */
  sourceKey: string;
  /** 单次请求关联指纹，与 requestId 一起裁决迟到响应。 */
  requestKey: string;
  /** 后台内存中的状态回写能力句柄，不包含 Plex 凭据。 */
  playbackReportId?: string;
}

export interface PlexRequestStartedNotice {
  type: typeof PLEX_REQUEST_STARTED_MESSAGE;
  requestId: string;
  sourceKey: string;
  requestKey: string;
}

export type PlexMediaSourceResponse =
  | { kind: 'redirect'; redirectUrl: string }
  | {
      kind: 'headers';
      statusCode: number;
      responseHeaders: readonly PlexResponseHeader[] | undefined;
    };

export interface PlexMediaSourceContext {
  request: URL;
  start: PlexStartRequestIdentity;
  response: PlexMediaSourceResponse;
}

/** legacy 302 只描述可直接读取和交给原生媒体元素的完整文件地址。 */
export const plexLegacyRedirectProvider: MediaSourceProvider<PlexMediaSourceContext> = {
  id: 'plex-legacy-redirect',
  resolve: (context) => {
    if (context.response.kind !== 'redirect') return undefined;
    let target: URL;
    try {
      target = new URL(context.response.redirectUrl);
    } catch {
      return undefined;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
    return {
      sourceId: context.start.sourceKey,
      access: { kind: 'direct-http-range', url: target.href },
      nativePlaybackUrl: target.href,
    };
  },
};

/** control-v1 只翻译控制交换协议，不参与媒体能力或播放策略判断。 */
export const plexControlV1Provider: MediaSourceProvider<PlexMediaSourceContext> = {
  id: 'plex-control-v1',
  resolve: (context) => {
    if (context.response.kind !== 'headers') return undefined;
    const { statusCode, responseHeaders } = context.response;
    if (statusCode < 200 || statusCode >= 300) return undefined;
    const headers = normalizeHeaders(responseHeaders);
    if (headers.get('x-shimweave-protocol') !== 'control-v1') return undefined;
    const sourceId = headers.get('x-shimweave-source-id');
    const rawControlUrl = headers.get('x-shimweave-control-url');
    const controlToken = headers.get('x-shimweave-control-token');
    if (!opaqueId(sourceId) || !opaqueId(controlToken) || !rawControlUrl) return undefined;

    let controlUrl: URL;
    try {
      controlUrl = new URL(rawControlUrl, context.request);
    } catch {
      return undefined;
    }
    if (
      controlUrl.origin !== context.request.origin ||
      controlUrl.pathname !== '/_shimweave/control/v1/range' ||
      controlUrl.search !== '' ||
      controlUrl.hash !== ''
    ) {
      return undefined;
    }
    return {
      sourceId,
      access: {
        kind: 'controlled-http-range',
        url: controlUrl.href,
        requestHeaders: { 'X-ShimWeave-Control-Token': controlToken },
        responseUrlHeader: 'X-ShimWeave-Media-Url',
        expectedStatus: 204,
      },
    };
  },
};

export const plexMediaSourceProviders: readonly MediaSourceProvider<PlexMediaSourceContext>[] = [
  plexLegacyRedirectProvider,
  plexControlV1Provider,
];

/**
 * 只有 Plex Web 的 DASH 建流请求被外部媒体 302 接管时才建立 ShimWeave 会话。
 * 正常返回 manifest 的本地媒体不会经过这个边界。
 */
export const parsePlexMediaRedirect = (
  requestUrl: string,
  redirectUrl: string,
  requestId: string,
): PlexMediaSourceNotice | undefined =>
  parsePlexMediaSourceResponse(requestUrl, { kind: 'redirect', redirectUrl }, requestId);

export interface PlexResponseHeader {
  name: string;
  value?: string | undefined;
}

/**
 * Gateway control-v1 用响应头交付稳定控制票据，使原始 Shaka 请求在
 * Gateway 终止，而媒体 Range 只由 ShimWeave 发往 CDN。
 */
export const parsePlexControlResponse = (
  requestUrl: string,
  statusCode: number,
  responseHeaders: readonly PlexResponseHeader[] | undefined,
  requestId: string,
): PlexMediaSourceNotice | undefined =>
  parsePlexMediaSourceResponse(
    requestUrl,
    { kind: 'headers', statusCode, responseHeaders },
    requestId,
  );

export const parsePlexMediaSourceResponse = (
  requestUrl: string,
  response: PlexMediaSourceResponse,
  requestId: string,
  providers: readonly MediaSourceProvider<PlexMediaSourceContext>[] = plexMediaSourceProviders,
): PlexMediaSourceNotice | undefined => {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return undefined;
  }
  const start = parsePlexStartRequest(request);
  if (!start || !nonEmptyString(requestId)) return undefined;
  const resolution = resolveMediaSource({ request, start, response }, providers);
  if (resolution.status !== 'claimed') return undefined;
  return {
    type: PLEX_MEDIA_SOURCE_MESSAGE,
    source: resolution.source,
    metadataPath: start.metadataPath,
    mediaIndex: start.mediaIndex,
    partIndex: start.partIndex,
    requestId,
    sourceKey: start.sourceKey,
    requestKey: start.requestKey,
  };
};

export const parsePlexRequestStarted = (
  requestUrl: string,
  requestId: string,
): PlexRequestStartedNotice | undefined => {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return undefined;
  }
  const start = parsePlexStartRequest(request);
  if (!start || !nonEmptyString(requestId)) return undefined;
  return {
    type: PLEX_REQUEST_STARTED_MESSAGE,
    requestId,
    sourceKey: start.sourceKey,
    requestKey: start.requestKey,
  };
};

export const isPlexMediaSourceNotice = (value: unknown): value is PlexMediaSourceNotice => {
  if (!isRecord(value) || value.type !== PLEX_MEDIA_SOURCE_MESSAGE) return false;
  return (
    isMediaSourceDescriptor(value.source) &&
    nonEmptyString(value.metadataPath) &&
    Number.isSafeInteger(value.mediaIndex) &&
    Number(value.mediaIndex) >= 0 &&
    Number.isSafeInteger(value.partIndex) &&
    Number(value.partIndex) >= 0 &&
    nonEmptyString(value.requestId) &&
    nonEmptyString(value.sourceKey) &&
    nonEmptyString(value.requestKey) &&
    (value.playbackReportId === undefined ||
      opaqueId(typeof value.playbackReportId === 'string' ? value.playbackReportId : undefined))
  );
};

export const isPlexRequestStartedNotice = (value: unknown): value is PlexRequestStartedNotice =>
  isRecord(value) &&
  value.type === PLEX_REQUEST_STARTED_MESSAGE &&
  nonEmptyString(value.requestId) &&
  nonEmptyString(value.sourceKey) &&
  nonEmptyString(value.requestKey);

/** Plex 播放位置在页面时间轴中使用毫秒；异常或超出时长的值不得进入媒体运行时。 */
export const parsePlexTimelineSeconds = (
  positionMilliseconds: string | null,
  durationMilliseconds: string | null,
): number | undefined => {
  const position = nonNegativeNumber(positionMilliseconds);
  const duration = positiveNumber(durationMilliseconds);
  if (position === undefined || duration === undefined || position > duration) return undefined;
  return position / 1000;
};

const nonNegativeNumber = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const positiveNumber = (value: string | null): number | undefined => {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const opaqueId = (value: string | undefined): value is string =>
  value !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(value);

const normalizeHeaders = (
  headers: readonly PlexResponseHeader[] | undefined,
): Map<string, string> => {
  const normalized = new Map<string, string>();
  for (const header of headers ?? []) {
    if (typeof header.name !== 'string' || typeof header.value !== 'string') continue;
    normalized.set(header.name.toLowerCase(), header.value.trim());
  }
  return normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
