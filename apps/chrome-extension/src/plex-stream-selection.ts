import {
  createPlexMetadataRequest,
  createPlexStreamFileRequest,
  PLEX_STREAM_KEY,
  type PlexStreamSelection,
  type PlexTimelineContext,
  parsePlexStreamSelection,
} from '@shimweave/adapter-plex';

export const PLEX_STREAM_SELECTION_MESSAGE = 'shimweave:plex-stream-selection' as const;
export const PLEX_SUBTITLE_FILE_MESSAGE = 'shimweave:plex-subtitle-file' as const;
/** 后台看到 Plex Web 记下新的字幕选择后通知页面，页面据此重新读取选择。 */
export const PLEX_SUBTITLE_CHANGED_MESSAGE = 'shimweave:plex-subtitle-changed' as const;

/** 页面只提交播放会话句柄和 Media/Part 位置，由后台用会话凭据读取 Plex 的音轨选择。 */
export interface PlexStreamSelectionMessage {
  type: typeof PLEX_STREAM_SELECTION_MESSAGE;
  reportId: string;
  mediaIndex: number;
  partIndex: number;
}

export const isPlexStreamSelectionMessage = (
  value: unknown,
): value is PlexStreamSelectionMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === PLEX_STREAM_SELECTION_MESSAGE &&
    typeof message.reportId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(message.reportId) &&
    nonNegativeInteger(message.mediaIndex) &&
    nonNegativeInteger(message.partIndex)
  );
};

/**
 * 读取失败、超时或响应不可解析时返回只标记 readFailed 的空选择，播放按容器默认音轨继续；
 * 音轨选择是增强，不能阻断起播。
 */
export const fetchPlexStreamSelection = async (
  context: PlexTimelineContext,
  mediaIndex: number,
  partIndex: number,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  timeoutMilliseconds = 3_000,
): Promise<PlexStreamSelection> => {
  const request = createPlexMetadataRequest(context);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetcher(request.url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Plex-Token': request.token },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { readFailed: true };
    return parsePlexStreamSelection(await response.json(), mediaIndex, partIndex);
  } catch {
    return { readFailed: true };
  } finally {
    clearTimeout(timeout);
  }
};

/** 页面请求外挂字幕文件：只提交会话句柄与 `/library/streams/{id}`，由后台带会话凭据读取。 */
export interface PlexSubtitleFileMessage {
  type: typeof PLEX_SUBTITLE_FILE_MESSAGE;
  reportId: string;
  key: string;
}

export interface PlexSubtitleFileResponse {
  /** 读取失败、超时或超出大小上限时缺失。 */
  text?: string;
}

export const isPlexSubtitleFileMessage = (value: unknown): value is PlexSubtitleFileMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === PLEX_SUBTITLE_FILE_MESSAGE &&
    typeof message.reportId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(message.reportId) &&
    typeof message.key === 'string' &&
    PLEX_STREAM_KEY.test(message.key)
  );
};

export const isPlexSubtitleChangedMessage = (
  value: unknown,
): value is { type: typeof PLEX_SUBTITLE_CHANGED_MESSAGE } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === PLEX_SUBTITLE_CHANGED_MESSAGE;

/** 外挂字幕文件的大小上限。正常的整片 SRT 只有几百 KB，超出时按读取失败处理。 */
export const PLEX_SUBTITLE_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 读取外挂字幕文件的文本。Cirvel 已把字幕统一转为 UTF-8，这里按 UTF-8 解码；
 * 失败时返回空应答，页面提示字幕不可用，视频照常播放。
 */
export const fetchPlexSubtitleFile = async (
  context: PlexTimelineContext,
  key: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  timeoutMilliseconds = 10_000,
): Promise<PlexSubtitleFileResponse> => {
  const request = createPlexStreamFileRequest(context, key);
  if (!request) return {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetcher(request.url, {
      method: 'GET',
      headers: { 'X-Plex-Token': request.token },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return {};
    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > PLEX_SUBTITLE_FILE_MAX_BYTES) return {};
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > PLEX_SUBTITLE_FILE_MAX_BYTES) return {};
    return { text: new TextDecoder('utf-8').decode(bytes) };
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
};

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
