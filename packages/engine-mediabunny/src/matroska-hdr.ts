import type { HdrConfiguration, Rational } from '@shimweave/contracts';

const MAX_HEADER_PROBE_BYTES = 512 * 1024;

const ID = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  defaultDuration: 0x23e383,
  blockAdditionMapping: 0x41e4,
  blockAddIdType: 0x41e7,
  blockAddIdExtraData: 0x41ed,
  video: 0xe0,
  colour: 0x55b0,
  maxCll: 0x55bc,
  maxFall: 0x55bd,
  masteringMetadata: 0x55d0,
  primaryRChromaticityX: 0x55d1,
  primaryRChromaticityY: 0x55d2,
  primaryGChromaticityX: 0x55d3,
  primaryGChromaticityY: 0x55d4,
  primaryBChromaticityX: 0x55d5,
  primaryBChromaticityY: 0x55d6,
  whitePointChromaticityX: 0x55d7,
  whitePointChromaticityY: 0x55d8,
  luminanceMax: 0x55d9,
  luminanceMin: 0x55da,
} as const;

const DOLBY_VISION_BLOCK_TYPES = new Set([0x64766343, 0x64767643, 0x64767743]);

interface RangeReader {
  read(start: number, end: number): Promise<Uint8Array>;
}

interface ElementHeader {
  id: number;
  elementStart: number;
  dataStart: number;
  dataEnd: number | undefined;
}

interface SeekEntry {
  id: number;
  position: number;
}

export interface MatroskaTrackMetadata {
  frameRate?: Rational;
  hdr?: HdrConfiguration;
}

/**
 * 仅补充 Mediabunny 公开 Track API 没有暴露的 Matroska HDR 和默认帧率字段。
 * 探测最多读取两个 512 KiB 窗口，不扫描 Cluster，也不把缺失字段推断为某种 HDR 格式。
 */
export const readMatroskaTrackMetadata = async (
  reader: RangeReader,
  sizeBytes: number,
): Promise<ReadonlyMap<number, MatroskaTrackMetadata>> => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return new Map();

  const firstEnd = Math.min(sizeBytes, MAX_HEADER_PROBE_BYTES);
  const first = await reader.read(0, firstEnd);
  const segment = findElement(first, 0, first.length, ID.segment);
  if (!segment) return new Map();

  const segmentEnd = Math.min(segment.dataEnd ?? first.length, first.length);
  const directTracks = findElement(first, segment.dataStart, segmentEnd, ID.tracks);
  if (directTracks) {
    const parsed = parseTracks(first, directTracks);
    if (
      parsed.size > 0 ||
      (directTracks.dataEnd !== undefined && directTracks.dataEnd <= first.length)
    ) {
      return parsed;
    }
    return readTracksWindow(reader, sizeBytes, directTracks.elementStart);
  }

  const seekHead = findElement(first, segment.dataStart, segmentEnd, ID.seekHead);
  const tracksSeek = seekHead
    ? parseSeekEntries(first, seekHead).find((entry) => entry.id === ID.tracks)
    : undefined;
  if (!tracksSeek) return new Map();

  const tracksOffset = segment.dataStart + tracksSeek.position;
  if (!Number.isSafeInteger(tracksOffset) || tracksOffset < 0 || tracksOffset >= sizeBytes) {
    return new Map();
  }
  return readTracksWindow(reader, sizeBytes, tracksOffset);
};

const readTracksWindow = async (
  reader: RangeReader,
  sizeBytes: number,
  tracksOffset: number,
): Promise<ReadonlyMap<number, MatroskaTrackMetadata>> => {
  const targetEnd = Math.min(sizeBytes, tracksOffset + MAX_HEADER_PROBE_BYTES);
  const target = await reader.read(tracksOffset, targetEnd);
  const tracks = readElementHeader(target, 0);
  return tracks?.id === ID.tracks ? parseTracks(target, tracks) : new Map();
};

const parseTracks = (
  bytes: Uint8Array,
  tracks: ElementHeader,
): ReadonlyMap<number, MatroskaTrackMetadata> => {
  const result = new Map<number, MatroskaTrackMetadata>();
  const end = Math.min(tracks.dataEnd ?? bytes.length, bytes.length);
  forEachElement(bytes, tracks.dataStart, end, (element) => {
    if (element.id !== ID.trackEntry || element.dataEnd === undefined || element.dataEnd > end) {
      return;
    }
    const parsed = parseTrackEntry(bytes, element);
    if (parsed) result.set(parsed.trackNumber, parsed.metadata);
  });
  return result;
};

const parseTrackEntry = (
  bytes: Uint8Array,
  entry: ElementHeader,
): { trackNumber: number; metadata: MatroskaTrackMetadata } | undefined => {
  if (entry.dataEnd === undefined) return undefined;
  const entryEnd = entry.dataEnd;
  let trackNumber: number | undefined;
  let trackType: number | undefined;
  let codecId: string | undefined;
  let defaultDuration: number | undefined;
  let dolbyVision: HdrConfiguration | undefined;
  let staticHdr: Omit<HdrConfiguration, 'kind'> = {};

  forEachElement(bytes, entry.dataStart, entryEnd, (element) => {
    if (element.dataEnd === undefined || element.dataEnd > entryEnd) return;
    if (element.id === ID.trackNumber) trackNumber = readUnsigned(bytes, element);
    if (element.id === ID.trackType) trackType = readUnsigned(bytes, element);
    if (element.id === ID.codecId) codecId = readAscii(bytes, element);
    if (element.id === ID.defaultDuration) defaultDuration = readUnsigned(bytes, element);
    if (element.id === ID.blockAdditionMapping) {
      dolbyVision ??= parseDolbyVisionMapping(bytes, element);
    }
    if (element.id === ID.video) staticHdr = parseVideoHdr(bytes, element);
  });

  if (trackNumber === undefined || trackType !== 1) {
    return undefined;
  }

  const hdr =
    codecId === 'V_MPEGH/ISO/HEVC' && (dolbyVision || Object.keys(staticHdr).length > 0)
      ? dolbyVision
        ? { ...staticHdr, ...dolbyVision }
        : { kind: 'hdr-unknown' as const, ...staticHdr }
      : undefined;
  const frameRate = defaultDuration ? rationalFromNanoseconds(defaultDuration) : undefined;
  if (!hdr && !frameRate) return undefined;

  return {
    trackNumber,
    metadata: {
      ...(frameRate ? { frameRate } : {}),
      ...(hdr ? { hdr } : {}),
    },
  };
};

const rationalFromNanoseconds = (duration: number): Rational | undefined => {
  if (!Number.isSafeInteger(duration) || duration <= 0) return undefined;
  const nanosecondsPerSecond = 1_000_000_000;
  const divisor = greatestCommonDivisor(nanosecondsPerSecond, duration);
  return {
    numerator: nanosecondsPerSecond / divisor,
    denominator: duration / divisor,
  };
};

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
};

const parseDolbyVisionMapping = (
  bytes: Uint8Array,
  mapping: ElementHeader,
): HdrConfiguration | undefined => {
  if (mapping.dataEnd === undefined) return undefined;
  const mappingEnd = mapping.dataEnd;
  let blockType: number | undefined;
  let extraData: Uint8Array | undefined;
  forEachElement(bytes, mapping.dataStart, mappingEnd, (element) => {
    if (element.dataEnd === undefined || element.dataEnd > mappingEnd) return;
    if (element.id === ID.blockAddIdType) blockType = readUnsigned(bytes, element);
    if (element.id === ID.blockAddIdExtraData) {
      extraData = bytes.subarray(element.dataStart, element.dataEnd);
    }
  });
  if (!blockType || !DOLBY_VISION_BLOCK_TYPES.has(blockType) || !extraData) return undefined;
  return parseDolbyVisionConfiguration(extraData);
};

const parseDolbyVisionConfiguration = (data: Uint8Array): HdrConfiguration | undefined => {
  const profileByte = data[2];
  const flagsByte = data[3];
  if (profileByte === undefined || flagsByte === undefined) return undefined;
  const profile = (profileByte >> 1) & 0x7f;
  const level = ((profileByte & 0x01) << 5) | ((flagsByte >> 3) & 0x1f);
  const compatibilityByte = data[4];
  const compatibilityId =
    compatibilityByte === undefined ? undefined : (compatibilityByte >> 4) & 0x0f;
  const validProfile = profile <= 10 || profile === 20;
  if (!validProfile) return undefined;
  return {
    kind: 'dolby-vision',
    profile,
    level,
    ...(compatibilityId !== undefined ? { compatibilityId } : {}),
    ...(compatibilityId === 1 ? { hasHdr10BaseLayer: true } : {}),
  };
};

const parseVideoHdr = (bytes: Uint8Array, video: ElementHeader): Omit<HdrConfiguration, 'kind'> => {
  if (video.dataEnd === undefined) return {};
  const colour = findElement(bytes, video.dataStart, video.dataEnd, ID.colour);
  if (!colour || colour.dataEnd === undefined) return {};
  const colourEnd = colour.dataEnd;
  const result: Omit<HdrConfiguration, 'kind'> = {};
  const mastering = findElement(bytes, colour.dataStart, colour.dataEnd, ID.masteringMetadata);

  forEachElement(bytes, colour.dataStart, colourEnd, (element) => {
    if (element.dataEnd === undefined || element.dataEnd > colourEnd) return;
    const value = readUnsigned(bytes, element);
    if (element.id === ID.maxCll && value !== undefined) result.maxContentLightLevel = value;
    if (element.id === ID.maxFall && value !== undefined) {
      result.maxFrameAverageLightLevel = value;
    }
  });
  if (mastering?.dataEnd !== undefined) {
    const serialized = serializeMasteringDisplay(bytes, mastering);
    if (serialized) result.masteringDisplay = serialized;
  }
  return result;
};

const MASTERING_FIELDS = [
  [ID.primaryRChromaticityX, 'rx'],
  [ID.primaryRChromaticityY, 'ry'],
  [ID.primaryGChromaticityX, 'gx'],
  [ID.primaryGChromaticityY, 'gy'],
  [ID.primaryBChromaticityX, 'bx'],
  [ID.primaryBChromaticityY, 'by'],
  [ID.whitePointChromaticityX, 'wx'],
  [ID.whitePointChromaticityY, 'wy'],
  [ID.luminanceMax, 'lmax'],
  [ID.luminanceMin, 'lmin'],
] as const;

const serializeMasteringDisplay = (
  bytes: Uint8Array,
  element: ElementHeader,
): string | undefined => {
  if (element.dataEnd === undefined) return undefined;
  const elementEnd = element.dataEnd;
  const values = new Map<number, number>();
  forEachElement(bytes, element.dataStart, elementEnd, (child) => {
    if (child.dataEnd === undefined || child.dataEnd > elementEnd) return;
    const value = readFloat(bytes, child);
    if (value !== undefined) values.set(child.id, value);
  });
  const fields = MASTERING_FIELDS.flatMap(([id, name]) => {
    const value = values.get(id);
    return value === undefined ? [] : [`${name}=${value}`];
  });
  return fields.length > 0 ? fields.join(',') : undefined;
};

const parseSeekEntries = (bytes: Uint8Array, seekHead: ElementHeader): SeekEntry[] => {
  if (seekHead.dataEnd === undefined) return [];
  const result: SeekEntry[] = [];
  forEachElement(bytes, seekHead.dataStart, seekHead.dataEnd, (element) => {
    if (element.id !== ID.seek || element.dataEnd === undefined) return;
    const elementEnd = element.dataEnd;
    let id: number | undefined;
    let position: number | undefined;
    forEachElement(bytes, element.dataStart, elementEnd, (child) => {
      if (child.dataEnd === undefined || child.dataEnd > elementEnd) return;
      if (child.id === ID.seekId) id = readUnsigned(bytes, child);
      if (child.id === ID.seekPosition) position = readUnsigned(bytes, child);
    });
    if (id !== undefined && position !== undefined) result.push({ id, position });
  });
  return result;
};

const findElement = (
  bytes: Uint8Array,
  start: number,
  end: number,
  id: number,
): ElementHeader | undefined => {
  let found: ElementHeader | undefined;
  forEachElement(bytes, start, end, (element) => {
    if (!found && element.id === id) found = element;
  });
  return found;
};

const forEachElement = (
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (element: ElementHeader) => void,
): void => {
  let offset = start;
  while (offset < end) {
    const element = readElementHeader(bytes, offset);
    if (!element || element.dataStart > end) return;
    visit(element);
    if (element.dataEnd === undefined || element.dataEnd <= offset || element.dataEnd > end) return;
    offset = element.dataEnd;
  }
};

const readElementHeader = (bytes: Uint8Array, offset: number): ElementHeader | undefined => {
  const id = readVint(bytes, offset, true);
  if (!id) return undefined;
  const size = readVint(bytes, offset + id.length, false);
  if (!size) return undefined;
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.value === undefined ? undefined : dataStart + size.value;
  if (dataStart > bytes.length || (dataEnd !== undefined && !Number.isSafeInteger(dataEnd))) {
    return undefined;
  }
  return { id: id.value ?? 0, elementStart: offset, dataStart, dataEnd };
};

const readVint = (
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number | undefined; length: number } | undefined => {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  let marker = 0x80;
  while ((first & marker) === 0) {
    marker >>= 1;
    length++;
  }
  if (length > 8 || offset + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (marker - 1);
  let unknown = !keepMarker && value === marker - 1;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { value: unknown ? undefined : value, length };
};

const readUnsigned = (bytes: Uint8Array, element: ElementHeader): number | undefined => {
  if (element.dataEnd === undefined || element.dataEnd - element.dataStart > 6) return undefined;
  let value = 0;
  for (let offset = element.dataStart; offset < element.dataEnd; offset++) {
    const byte = bytes[offset];
    if (byte === undefined) return undefined;
    value = value * 256 + byte;
  }
  return Number.isSafeInteger(value) ? value : undefined;
};

const readFloat = (bytes: Uint8Array, element: ElementHeader): number | undefined => {
  if (element.dataEnd === undefined) return undefined;
  const length = element.dataEnd - element.dataStart;
  if (length !== 4 && length !== 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, length);
  const value = length === 4 ? view.getFloat32(0) : view.getFloat64(0);
  return Number.isFinite(value) ? value : undefined;
};

const readAscii = (bytes: Uint8Array, element: ElementHeader): string | undefined => {
  if (element.dataEnd === undefined) return undefined;
  let result = '';
  for (let offset = element.dataStart; offset < element.dataEnd; offset++) {
    const byte = bytes[offset];
    if (byte === undefined) return undefined;
    if (byte > 0x7f) return undefined;
    result += String.fromCharCode(byte);
  }
  return result;
};
