export const PLEX_NATIVE_PROTOCOL = 'shimweave-plex-native-v1' as const;

export type PlexNativeMessage =
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'extension-host';
      type: 'host-ready';
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'watcher-ready';
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'hook-ready';
      shakaVersion: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'extension-host';
      type: 'source-available';
      requestKey: string;
      sourceKey: string;
      noticeId: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'source-rejected';
      requestKey: string;
      noticeId: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'blocked-source-retry';
      sourceKey: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'takeover-start';
      requestKey: string;
      noticeId: string;
      sessionId: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'extension-host';
      type: 'takeover-ready';
      sessionId: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'extension-host';
      type: 'takeover-error';
      sessionId: string;
      code: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'main-hook';
      type: 'takeover-stop';
      sessionId: string;
    }
  | {
      protocol: typeof PLEX_NATIVE_PROTOCOL;
      sender: 'extension-host';
      type: 'takeover-stopped';
      sessionId: string;
    };

/** 跨 MAIN 与隔离世界的控制协议不携带媒体地址、Plex Token 或 Gateway bearer。 */
export const isPlexNativeMessage = (value: unknown): value is PlexNativeMessage => {
  if (!isRecord(value) || value.protocol !== PLEX_NATIVE_PROTOCOL) return false;
  if (value.sender !== 'extension-host' && value.sender !== 'main-hook') return false;
  if (value.type === 'host-ready') {
    return value.sender === 'extension-host' && exactKeys(value, BASE_KEYS);
  }
  if (value.type === 'watcher-ready') {
    return value.sender === 'main-hook' && exactKeys(value, BASE_KEYS);
  }
  if (value.type === 'hook-ready') {
    return (
      value.sender === 'main-hook' &&
      nonEmptyString(value.shakaVersion) &&
      exactKeys(value, [...BASE_KEYS, 'shakaVersion'])
    );
  }
  if (value.type === 'source-available') {
    return (
      value.sender === 'extension-host' &&
      nonEmptyString(value.requestKey) &&
      nonEmptyString(value.sourceKey) &&
      opaqueId(value.noticeId) &&
      exactKeys(value, [...BASE_KEYS, 'requestKey', 'sourceKey', 'noticeId'])
    );
  }
  if (value.type === 'source-rejected') {
    return (
      value.sender === 'main-hook' &&
      nonEmptyString(value.requestKey) &&
      opaqueId(value.noticeId) &&
      exactKeys(value, [...BASE_KEYS, 'requestKey', 'noticeId'])
    );
  }
  if (value.type === 'blocked-source-retry') {
    return (
      value.sender === 'main-hook' &&
      nonEmptyString(value.sourceKey) &&
      exactKeys(value, [...BASE_KEYS, 'sourceKey'])
    );
  }
  if (value.type === 'takeover-start') {
    return (
      value.sender === 'main-hook' &&
      nonEmptyString(value.requestKey) &&
      opaqueId(value.noticeId) &&
      opaqueId(value.sessionId) &&
      exactKeys(value, [...BASE_KEYS, 'requestKey', 'noticeId', 'sessionId'])
    );
  }
  if (value.type === 'takeover-ready') {
    return (
      value.sender === 'extension-host' &&
      opaqueId(value.sessionId) &&
      exactKeys(value, [...BASE_KEYS, 'sessionId'])
    );
  }
  if (value.type === 'takeover-error') {
    return (
      value.sender === 'extension-host' &&
      opaqueId(value.sessionId) &&
      nonEmptyString(value.code) &&
      exactKeys(value, [...BASE_KEYS, 'sessionId', 'code'])
    );
  }
  if (value.type === 'takeover-stop') {
    return (
      value.sender === 'main-hook' &&
      opaqueId(value.sessionId) &&
      exactKeys(value, [...BASE_KEYS, 'sessionId'])
    );
  }
  return (
    value.sender === 'extension-host' &&
    value.type === 'takeover-stopped' &&
    opaqueId(value.sessionId) &&
    exactKeys(value, [...BASE_KEYS, 'sessionId'])
  );
};

const BASE_KEYS = ['protocol', 'sender', 'type'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
