import {
  createPlexMetadataRequest,
  type PlexStreamSelection,
  type PlexTimelineContext,
  parsePlexStreamSelection,
} from '@shimweave/adapter-plex';

export const PLEX_STREAM_SELECTION_MESSAGE = 'shimweave:plex-stream-selection' as const;

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
 * 读取失败、超时或响应不可解析时返回空选择，播放按容器默认音轨继续；音轨选择是增强，
 * 不能阻断起播。
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
    if (!response.ok) return {};
    return parsePlexStreamSelection(await response.json(), mediaIndex, partIndex);
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
};

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
