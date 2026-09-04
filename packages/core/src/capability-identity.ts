import type {
  CapabilityScope,
  ExactMediaConfiguration,
  MediaDescriptor,
  PlaybackPath,
} from '@shimweave/contracts';

/**
 * 能力身份使用确定性序列化，字段顺序变化不会导致缓存失效；短期媒体 URL 不得进入输入。
 */
export const canonicalizeCapabilityValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Capability identity rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeCapabilityValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeCapabilityValue(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Capability identity rejects ${typeof value}`);
};

export const createConfigurationKey = (
  schemaVersion: number,
  path: PlaybackPath,
  configuration: ExactMediaConfiguration,
): string => canonicalizeCapabilityValue({ configuration, path, schemaVersion });

export const createMediaFingerprint = (media: MediaDescriptor): string =>
  canonicalizeCapabilityValue({
    sourceFingerprint: media.sourceFingerprint,
    sourceId: media.sourceId,
    sizeBytes: media.sizeBytes,
  });

export const createCapabilityCacheKey = (
  scope: CapabilityScope,
  configurationKey: string,
): string =>
  canonicalizeCapabilityValue({
    configurationKey,
    engineKey: scope.engineKey,
    runtimeKey: scope.runtimeKey,
    schemaVersion: scope.schemaVersion,
  });

export const createSampleCacheKey = (
  scope: CapabilityScope,
  configurationKey: string,
  mediaFingerprint: string,
): string =>
  canonicalizeCapabilityValue({
    capabilityKey: createCapabilityCacheKey(scope, configurationKey),
    mediaFingerprint,
  });
