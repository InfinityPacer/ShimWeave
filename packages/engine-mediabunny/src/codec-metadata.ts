import type { HdrConfiguration, MediaColorSpace } from '@shimweave/contracts';

export interface ParsedCodecMetadata {
  profile?: string;
  level?: string;
  tier?: string;
  bitDepth?: number;
  chromaSubsampling?: string;
  hdr?: HdrConfiguration;
}

/** 容器只给出 sample entry 时，优先使用同轨 decoder config 暴露的完整 RFC 6381 标识。 */
export const selectCodecParameterString = (
  containerValue: string | undefined,
  decoderValue: string | undefined,
): string | undefined => {
  if (!containerValue) return decoderValue;
  if (!decoderValue) return containerValue;
  return !containerValue.includes('.') && decoderValue.includes('.')
    ? decoderValue
    : containerValue;
};

/** codec string 优先提供标准身份；decoder description 仅补充其中没有暴露的位深和色度。 */
export const parseCodecMetadata = (
  codecString: string | undefined,
  decoderDescription: Uint8Array | undefined,
): ParsedCodecMetadata => {
  if (!codecString) return {};
  const normalized = codecString.toLowerCase();
  if (normalized.startsWith('avc1.') || normalized.startsWith('avc3.')) {
    return parseAvc(normalized, decoderDescription);
  }
  if (normalized.startsWith('hvc1.') || normalized.startsWith('hev1.')) {
    return parseHevc(normalized, decoderDescription);
  }
  if (normalized.startsWith('av01.')) return parseAv1(normalized);
  if (normalized.startsWith('vp09.')) return parseVp9(normalized);
  if (normalized.startsWith('dvhe.') || normalized.startsWith('dvh1.')) {
    return parseDolbyVision(normalized);
  }
  if (normalized.startsWith('mp4a.40.')) return parseAac(normalized);
  return {};
};

export const inferHdrConfiguration = (
  codecString: string | undefined,
  colorSpace: MediaColorSpace | undefined,
  highDynamicRange: boolean,
): HdrConfiguration | undefined => {
  const codec = codecString?.toLowerCase();
  if (codec?.startsWith('dvhe.') || codec?.startsWith('dvh1.')) {
    return parseDolbyVision(codec).hdr;
  }
  const transfer = colorSpace?.transfer?.toLowerCase();
  if (transfer === 'hlg') return { kind: 'hlg' };
  if (transfer === 'pq') return { kind: 'hdr-unknown' };
  return highDynamicRange ? { kind: 'hdr-unknown' } : undefined;
};

export const copyDecoderDescription = (
  description: AllowSharedBufferSource | undefined,
): Uint8Array | undefined => {
  if (description === undefined) return undefined;
  const view = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  return view.slice();
};

/** 摘要只承担本地缓存失效身份，不用于安全校验。 */
export const fingerprintBytes = (bytes: Uint8Array): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
};

const parseAvc = (
  codecString: string,
  description: Uint8Array | undefined,
): ParsedCodecMetadata => {
  const compact = codecString.split('.')[1];
  const profileIdc =
    compact && compact.length >= 2 ? Number.parseInt(compact.slice(0, 2), 16) : NaN;
  const levelIdc = compact && compact.length >= 6 ? Number.parseInt(compact.slice(4, 6), 16) : NaN;
  const avcCProfile = description?.[0] === 1 ? description[1] : undefined;
  const avcCLevel = description?.[0] === 1 ? description[3] : undefined;
  const profile = Number.isFinite(profileIdc) ? profileIdc : avcCProfile;
  const level = Number.isFinite(levelIdc) ? levelIdc : avcCLevel;
  return {
    ...(profile !== undefined ? { profile: avcProfile(profile) } : {}),
    ...(level !== undefined ? { level: decimalLevel(level / 10) } : {}),
  };
};

const parseHevc = (
  codecString: string,
  description: Uint8Array | undefined,
): ParsedCodecMetadata => {
  const fields = codecString.split('.');
  const profileToken = fields[1]?.replace(/^[abc]/i, '');
  const levelToken = fields.find((field) => /^[lh]\d+$/i.test(field));
  const hvcC = description?.[0] === 1 && description.length >= 19 ? description : undefined;
  const profileByte = hvcC?.[1];
  const levelByte = hvcC?.[12];
  const chromaByte = hvcC?.[16];
  const bitDepthByte = hvcC?.[17];
  const profileIdc = profileToken
    ? Number.parseInt(profileToken, 10)
    : profileByte !== undefined
      ? profileByte & 0x1f
      : NaN;
  const levelIdc = levelToken
    ? Number.parseInt(levelToken.slice(1), 10)
    : hvcC
      ? levelByte
      : undefined;
  const tier =
    levelToken?.[0]?.toUpperCase() ??
    (profileByte !== undefined ? (profileByte & 0x20 ? 'H' : 'L') : undefined);
  const chroma = chromaByte !== undefined ? chromaByte & 0x03 : undefined;
  const bitDepth = bitDepthByte !== undefined ? 8 + (bitDepthByte & 0x07) : undefined;
  return {
    ...(Number.isFinite(profileIdc) ? { profile: hevcProfile(profileIdc) } : {}),
    ...(levelIdc !== undefined ? { level: decimalLevel(levelIdc / 30) } : {}),
    ...(tier ? { tier } : {}),
    ...(bitDepth !== undefined ? { bitDepth } : {}),
    ...(chroma !== undefined ? { chromaSubsampling: chromaLabel(chroma) } : {}),
  };
};

const parseAv1 = (codecString: string): ParsedCodecMetadata => {
  const fields = codecString.split('.');
  const profile = fields[1];
  const levelTier = fields[2];
  const bitDepth = fields[3] ? Number.parseInt(fields[3], 10) : NaN;
  return {
    ...(profile ? { profile } : {}),
    ...(levelTier && levelTier.length >= 3 ? { level: levelTier.slice(0, 2) } : {}),
    ...(levelTier && levelTier.length >= 3 ? { tier: levelTier.slice(2).toUpperCase() } : {}),
    ...(Number.isFinite(bitDepth) ? { bitDepth } : {}),
  };
};

const parseVp9 = (codecString: string): ParsedCodecMetadata => {
  const fields = codecString.split('.');
  const profile = fields[1];
  const level = fields[2];
  const bitDepth = fields[3] ? Number.parseInt(fields[3], 10) : NaN;
  return {
    ...(profile ? { profile } : {}),
    ...(level ? { level } : {}),
    ...(Number.isFinite(bitDepth) ? { bitDepth } : {}),
  };
};

const parseDolbyVision = (codecString: string): ParsedCodecMetadata => {
  const fields = codecString.split('.');
  const profile = fields[1] ? Number.parseInt(fields[1], 10) : NaN;
  const level = fields[2] ? Number.parseInt(fields[2], 10) : NaN;
  return {
    ...(Number.isFinite(profile) ? { profile: String(profile) } : {}),
    ...(Number.isFinite(level) ? { level: String(level) } : {}),
    hdr: {
      kind: 'dolby-vision',
      ...(Number.isFinite(profile) ? { profile } : {}),
      ...(Number.isFinite(level) ? { level } : {}),
    },
  };
};

const parseAac = (codecString: string): ParsedCodecMetadata => {
  const objectType = Number.parseInt(codecString.split('.')[2] ?? '', 10);
  const profiles: Record<number, string> = { 2: 'aac-lc', 5: 'he-aac', 29: 'he-aac-v2' };
  return Number.isFinite(objectType)
    ? { profile: profiles[objectType] ?? `audio-object-${objectType}` }
    : {};
};

const avcProfile = (value: number): string =>
  ({
    66: 'baseline',
    77: 'main',
    88: 'extended',
    100: 'high',
    110: 'high-10',
    122: 'high-4:2:2',
    244: 'high-4:4:4',
  })[value] ?? String(value);

const hevcProfile = (value: number): string =>
  ({ 1: 'main', 2: 'main-10', 3: 'main-still-picture' })[value] ?? String(value);

const chromaLabel = (value: number): string =>
  ({ 0: 'monochrome', 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' })[value] ?? String(value);

const decimalLevel = (value: number): string =>
  Number.isInteger(value) ? `${value}.0` : String(value);
