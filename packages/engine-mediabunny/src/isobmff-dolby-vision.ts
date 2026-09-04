import type { HdrConfiguration } from '@shimweave/contracts';

const BOX_HEADER_BYTES = 16;
const MAX_TOP_LEVEL_BOXES = 128;
const MAX_MOOV_PREFIX_BYTES = 4 * 1024 * 1024;
const INITIAL_MOOV_PREFIX_BYTES = 512 * 1024;
const VISUAL_SAMPLE_ENTRY_FIELDS_BYTES = 78;

interface RangeReader {
  read(start: number, end: number): Promise<Uint8Array>;
}

interface BoxHeader {
  readonly type: string;
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
}

export interface IsobmffDolbyVisionTrackMetadata {
  codecString: string;
  hdr: HdrConfiguration;
  decoderDescription?: Uint8Array;
  bitDepth?: number;
  chromaSubsampling?: string;
}

/**
 * 仅为 Mediabunny 尚未识别的 Dolby Vision sample entry 补充 dvcC/dvvC 事实。
 * 顶层 box 只读取头部，moov 最多读取 4 MiB 前缀，不扫描 mdat 或视频样本。
 */
export const readIsobmffDolbyVisionTrackMetadata = async (
  reader: RangeReader,
  sizeBytes: number,
): Promise<ReadonlyMap<number, IsobmffDolbyVisionTrackMetadata>> => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 8) return new Map();
  const moov = await findTopLevelBox(reader, sizeBytes, 'moov');
  if (!moov) return new Map();

  const maximumEnd = Math.min(moov.end, moov.start + MAX_MOOV_PREFIX_BYTES);
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let cursor = moov.start;
  let windowSize = INITIAL_MOOV_PREFIX_BYTES;
  while (cursor < maximumEnd) {
    const nextEnd = Math.min(maximumEnd, moov.start + windowSize);
    bytes = concatBytes(bytes, await reader.read(cursor, nextEnd));
    const result = parseMoovPrefix(bytes, moov.end - moov.start);
    if (result.size > 0 || nextEnd === moov.end) return result;
    cursor = nextEnd;
    windowSize = Math.min(MAX_MOOV_PREFIX_BYTES, windowSize * 2);
  }
  return new Map();
};

const parseMoovPrefix = (
  bytes: Uint8Array,
  declaredSize: number,
): ReadonlyMap<number, IsobmffDolbyVisionTrackMetadata> => {
  const root = readBoxHeader(bytes, 0, declaredSize);
  if (root?.type !== 'moov') return new Map();
  const result = new Map<number, IsobmffDolbyVisionTrackMetadata>();
  for (const trak of childBoxes(bytes, root)) {
    if (trak.type !== 'trak') continue;
    const trackId = readTrackId(bytes, trak);
    const metadata = readDolbyVisionSampleEntry(bytes, trak);
    if (trackId !== undefined && metadata) result.set(trackId, metadata);
  }
  return result;
};

const findTopLevelBox = async (
  reader: RangeReader,
  sizeBytes: number,
  type: string,
): Promise<BoxHeader | undefined> => {
  let offset = 0;
  for (let count = 0; count < MAX_TOP_LEVEL_BOXES && offset + 8 <= sizeBytes; count += 1) {
    const bytes = await reader.read(offset, Math.min(sizeBytes, offset + BOX_HEADER_BYTES));
    const local = readBoxHeader(bytes, 0, sizeBytes - offset);
    if (!local) return undefined;
    const box = {
      type: local.type,
      start: offset,
      dataStart: offset + local.dataStart,
      end: offset + local.end,
    } satisfies BoxHeader;
    if (box.type === type) return box;
    if (box.end <= offset || box.end > sizeBytes) return undefined;
    offset = box.end;
  }
  return undefined;
};

const readTrackId = (bytes: Uint8Array, trak: BoxHeader): number | undefined => {
  const tkhd = childBoxes(bytes, trak).find((box) => box.type === 'tkhd');
  if (!tkhd || tkhd.dataStart >= bytes.length) return undefined;
  const version = bytes[tkhd.dataStart];
  const trackIdOffset = tkhd.dataStart + (version === 1 ? 20 : 12);
  return readU32(bytes, trackIdOffset);
};

const readDolbyVisionSampleEntry = (
  bytes: Uint8Array,
  trak: BoxHeader,
): IsobmffDolbyVisionTrackMetadata | undefined => {
  const mdia = childBoxes(bytes, trak).find((box) => box.type === 'mdia');
  const minf = mdia && childBoxes(bytes, mdia).find((box) => box.type === 'minf');
  const stbl = minf && childBoxes(bytes, minf).find((box) => box.type === 'stbl');
  const stsd = stbl && childBoxes(bytes, stbl).find((box) => box.type === 'stsd');
  if (!stsd) return undefined;

  const entryCount = readU32(bytes, stsd.dataStart + 4);
  if (entryCount === undefined) return undefined;
  let offset = stsd.dataStart + 8;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = readBoxHeader(bytes, offset, Math.min(stsd.end, bytes.length));
    if (!entry) return undefined;
    if (entry.type === 'dvh1' || entry.type === 'dvhe') {
      const childrenStart = entry.dataStart + VISUAL_SAMPLE_ENTRY_FIELDS_BYTES;
      if (childrenStart > Math.min(entry.end, bytes.length)) return undefined;
      const children = childBoxes(bytes, { ...entry, dataStart: childrenStart });
      const dovi = children.find((box) => box.type === 'dvcC' || box.type === 'dvvC');
      if (!dovi) return undefined;
      const configuration = parseDolbyVisionConfiguration(
        bytes.subarray(dovi.dataStart, Math.min(dovi.end, bytes.length)),
      );
      if (!configuration) return undefined;
      const hvcC = children.find((box) => box.type === 'hvcC');
      const decoderDescription = hvcC
        ? bytes.slice(hvcC.dataStart, Math.min(hvcC.end, bytes.length))
        : undefined;
      return {
        codecString: `${entry.type}.${twoDigits(configuration.profile)}.${twoDigits(configuration.level)}`,
        hdr: configuration.hdr,
        ...(decoderDescription && decoderDescription.length > 0
          ? {
              decoderDescription,
              ...readHevcShape(decoderDescription),
            }
          : {}),
      };
    }
    offset = entry.end;
  }
  return undefined;
};

const parseDolbyVisionConfiguration = (
  data: Uint8Array,
): { profile: number; level: number; hdr: HdrConfiguration } | undefined => {
  const profileByte = data[2];
  const flagsByte = data[3];
  if (profileByte === undefined || flagsByte === undefined) return undefined;
  const profile = (profileByte >> 1) & 0x7f;
  const level = ((profileByte & 0x01) << 5) | ((flagsByte >> 3) & 0x1f);
  if (!((profile <= 10 || profile === 20) && level <= 63)) return undefined;
  const compatibilityId = data[4] === undefined ? undefined : (data[4] >> 4) & 0x0f;
  return {
    profile,
    level,
    hdr: {
      kind: 'dolby-vision',
      profile,
      level,
      ...(compatibilityId !== undefined ? { compatibilityId } : {}),
      ...(compatibilityId === 1 ? { hasHdr10BaseLayer: true } : {}),
    },
  };
};

const readHevcShape = (
  description: Uint8Array,
): Pick<IsobmffDolbyVisionTrackMetadata, 'bitDepth' | 'chromaSubsampling'> => {
  if (description[0] !== 1 || description.length < 18) return {};
  const chroma = description[16];
  const bitDepth = description[17];
  return {
    ...(bitDepth !== undefined ? { bitDepth: 8 + (bitDepth & 0x07) } : {}),
    ...(chroma !== undefined ? { chromaSubsampling: chromaLabel(chroma & 0x03) } : {}),
  };
};

const chromaLabel = (value: number): string =>
  ({ 0: 'monochrome', 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' })[value] ?? String(value);

const twoDigits = (value: number): string => String(value).padStart(2, '0');

const childBoxes = (bytes: Uint8Array, parent: BoxHeader): BoxHeader[] => {
  const children: BoxHeader[] = [];
  const availableEnd = Math.min(parent.end, bytes.length);
  let offset = parent.dataStart;
  while (offset + 8 <= availableEnd) {
    const box = readBoxHeader(bytes, offset, parent.end);
    if (!box || box.end <= offset) break;
    children.push(box);
    offset = box.end;
  }
  return children;
};

const readBoxHeader = (bytes: Uint8Array, offset: number, limit: number): BoxHeader | undefined => {
  const size32 = readU32(bytes, offset);
  if (size32 === undefined || offset + 8 > bytes.length || offset + 8 > limit) return undefined;
  const type = readAscii(bytes, offset + 4, 4);
  if (!type) return undefined;

  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    const largeSize = readU64(bytes, offset + 8);
    if (largeSize === undefined) return undefined;
    headerSize = 16;
    size = largeSize;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize) return undefined;
  const end = offset + size;
  if (!Number.isSafeInteger(end) || end > limit) return undefined;
  return { type, start: offset, dataStart: offset + headerSize, end };
};

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) return right;
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
};

const readU32 = (bytes: Uint8Array, offset: number): number | undefined => {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
};

const readU64 = (bytes: Uint8Array, offset: number): number | undefined => {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string | undefined => {
  if (offset < 0 || offset + length > bytes.length) return undefined;
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
};
