export interface PlexStartRequestIdentity {
  metadataPath: string;
  mediaIndex: number;
  partIndex: number;
  sourceKey: string;
  requestKey: string;
}

/** 返回不含 Plex Token 的播放身份，供网络层与页面播放器桥使用同一关联规则。 */
export const parsePlexStartRequestIdentity = (
  requestUrl: string,
): PlexStartRequestIdentity | undefined => {
  try {
    return parsePlexStartRequest(new URL(requestUrl));
  } catch {
    return undefined;
  }
};

export const parsePlexStartRequest = (request: URL): PlexStartRequestIdentity | undefined => {
  if (request.protocol !== 'http:' && request.protocol !== 'https:') return undefined;
  if (request.pathname !== '/video/:/transcode/universal/start.mpd') return undefined;
  const metadataPath = request.searchParams.get('path');
  if (!metadataPath?.startsWith('/library/metadata/')) return undefined;
  const mediaIndex = nonNegativeInteger(request.searchParams.get('mediaIndex'));
  const partIndex = nonNegativeInteger(request.searchParams.get('partIndex'));
  if (mediaIndex === undefined || partIndex === undefined) return undefined;
  const requestIdentity = firstQueryValue(request, [
    'X-Plex-Playback-Session-Id',
    'X-Plex-Playback-Id',
    'X-Plex-Session-Id',
    'X-Plex-Session-Identifier',
    'session',
  ]);
  const sourceKey = `plex:${request.origin}:${metadataPath}:${mediaIndex}:${partIndex}`;
  return {
    metadataPath,
    mediaIndex,
    partIndex,
    sourceKey,
    requestKey: `${sourceKey}:${requestIdentity ?? 'unscoped'}`,
  };
};

const nonNegativeInteger = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const firstQueryValue = (request: URL, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const values = request.searchParams.getAll(name);
    if (values.length === 1 && values[0]?.trim()) return values[0];
  }
  return undefined;
};
