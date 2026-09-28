import type {
  SubtitleCue,
  SubtitleCueSink,
  SubtitleMediaTrack,
  SubtitleUnavailableReason,
} from '@shimweave/contracts';
import type { ByteCoverage } from './byte-coverage.js';
import {
  type ElementHeader,
  findElement,
  forEachElement,
  parseSeekEntries,
  type RangeReader,
  readAscii,
  readElementHeader,
  readUnsigned,
  readUtf8,
  readVint,
} from './ebml.js';
import { normalizeSubtitleText, type TextSubtitleFormat } from './subtitle-text.js';

const MAX_HEADER_PROBE_BYTES = 512 * 1024;
const MAX_CUES_BYTES = 32 * 1024 * 1024;
const MAX_ELEMENT_HEADER_BYTES = 12;
const CLUSTER_SCAN_WINDOW_BYTES = 256 * 1024;
/** 块内没有 BlockDuration、轨道也没有 DefaultDuration 时的显示时长。 */
const FALLBACK_CUE_SECONDS = 5;
const MAX_SUBTITLE_BLOCK_BYTES = 1024 * 1024;

const ID = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  name: 0x536e,
  language: 0x22b59c,
  languageBcp47: 0x22b59d,
  flagDefault: 0x88,
  flagForced: 0x55aa,
  defaultDuration: 0x23e383,
  contentEncodings: 0x6d80,
  contentEncoding: 0x6240,
  contentEncodingScope: 0x5032,
  contentEncodingType: 0x5033,
  contentCompression: 0x5034,
  contentCompAlgo: 0x4254,
  contentCompSettings: 0x4255,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
} as const;

const SUBTITLE_TRACK_TYPE = 0x11;

const CODEC_BY_ID: Readonly<Record<string, string>> = {
  'S_TEXT/UTF8': 'srt',
  'S_TEXT/ASCII': 'srt',
  'S_TEXT/WEBVTT': 'webvtt',
  'S_TEXT/ASS': 'ass',
  'S_TEXT/SSA': 'ssa',
  S_ASS: 'ass',
  S_SSA: 'ssa',
  'S_HDMV/PGS': 'pgs',
  'S_HDMV/TEXTST': 'hdmv_textst',
  S_VOBSUB: 'vobsub',
  S_DVBSUB: 'dvb_subtitle',
  S_KATE: 'kate',
};

/** 帧负载的解码方式。加密和未知压缩一律视为不支持，不尝试显示可能错误的内容。 */
export type MatroskaContentEncoding =
  | { kind: 'none' }
  | { kind: 'zlib' }
  | { kind: 'header-stripping'; prefix: Uint8Array }
  | { kind: 'unsupported' };

export interface MatroskaSubtitleTrack {
  trackNumber: number;
  codecId: string;
  codec: string;
  language?: string;
  name?: string;
  isDefault: boolean;
  isForced: boolean;
  defaultDurationNs?: number;
  encoding: MatroskaContentEncoding;
}

export interface MatroskaSubtitleLayout {
  segmentDataStart: number;
  segmentEnd: number;
  timestampScale: number;
  subtitleTracks: readonly MatroskaSubtitleTrack[];
  /** Cues 元素的绝对文件位置。 */
  cuesPosition?: number;
  /** 头部窗口内出现的第一个 Cluster；缺少 Cues 时只能从这里开始。 */
  firstClusterPosition?: number;
}

export interface MatroskaCuePoint {
  timeTicks: number;
  track: number;
  clusterPosition: number;
}

export class MatroskaSubtitleUnavailableError extends Error {
  constructor(readonly reason: SubtitleUnavailableReason) {
    super(`Subtitle is unavailable: ${reason}`);
    this.name = 'MatroskaSubtitleUnavailableError';
  }
}

export const subtitleMediaTrack = (track: MatroskaSubtitleTrack): SubtitleMediaTrack => ({
  id: String(track.trackNumber),
  kind: 'subtitle',
  codec: track.codec,
  isDefault: track.isDefault,
  isForced: track.isForced,
  ...(track.language ? { language: track.language } : {}),
  ...(track.name ? { title: track.name } : {}),
});

/**
 * 读取字幕所需的 Segment 布局：字幕 TrackEntry、TimestampScale 与 Cues 位置。
 * 只读取头部窗口和 SeekHead 指向的元素，这些字节在描述阶段已被解封装器读过。
 */
export const readMatroskaSubtitleLayout = async (
  reader: RangeReader,
  sizeBytes: number,
): Promise<MatroskaSubtitleLayout | undefined> => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return undefined;
  const first = await reader.read(0, Math.min(sizeBytes, MAX_HEADER_PROBE_BYTES));
  const segment = findElement(first, 0, first.length, ID.segment);
  if (!segment) return undefined;
  const segmentDataStart = segment.dataStart;
  const segmentEnd = Math.min(sizeBytes, segment.dataEnd ?? sizeBytes);

  const direct = new Map<number, ElementHeader>();
  let firstClusterPosition: number | undefined;
  forEachElement(first, segmentDataStart, Math.min(segmentEnd, first.length), (element) => {
    if (element.id === ID.cluster) firstClusterPosition ??= element.elementStart;
    if (!direct.has(element.id)) direct.set(element.id, element);
  });
  const seekPositions = new Map<number, number>();
  const seekHead = direct.get(ID.seekHead);
  if (seekHead) {
    for (const entry of parseSeekEntries(first, seekHead)) {
      const position = segmentDataStart + entry.position;
      if (Number.isSafeInteger(position) && position < segmentEnd) {
        if (!seekPositions.has(entry.id)) seekPositions.set(entry.id, position);
      }
    }
  }

  const elementBytes = async (id: number, maxBytes: number) => {
    const inWindow = direct.get(id);
    if (inWindow?.dataEnd !== undefined && inWindow.dataEnd <= first.length) {
      return { bytes: first, element: inWindow };
    }
    const position = inWindow?.elementStart ?? seekPositions.get(id);
    if (position === undefined) return undefined;
    const window = await reader.read(position, Math.min(segmentEnd, position + maxBytes));
    const element = readElementHeader(window, 0);
    if (element?.id !== id || element.dataEnd === undefined || element.dataEnd > window.length) {
      return undefined;
    }
    return { bytes: window, element };
  };

  const [info, tracks] = await Promise.all([
    elementBytes(ID.info, 64 * 1024),
    elementBytes(ID.tracks, MAX_HEADER_PROBE_BYTES),
  ]);
  let timestampScale = 1_000_000;
  if (info?.element.dataEnd !== undefined) {
    const scale = findElement(
      info.bytes,
      info.element.dataStart,
      info.element.dataEnd,
      ID.timestampScale,
    );
    const value = scale ? readUnsigned(info.bytes, scale) : undefined;
    if (value !== undefined && value > 0) timestampScale = value;
  }
  const subtitleTracks: MatroskaSubtitleTrack[] = [];
  if (tracks?.element.dataEnd !== undefined) {
    const tracksEnd = tracks.element.dataEnd;
    forEachElement(tracks.bytes, tracks.element.dataStart, tracksEnd, (entry) => {
      if (entry.id !== ID.trackEntry || entry.dataEnd === undefined || entry.dataEnd > tracksEnd) {
        return;
      }
      const parsed = parseSubtitleTrackEntry(tracks.bytes, entry);
      if (parsed) subtitleTracks.push(parsed);
    });
  }
  const cuesPosition = direct.get(ID.cues)?.elementStart ?? seekPositions.get(ID.cues);
  return {
    segmentDataStart,
    segmentEnd,
    timestampScale,
    subtitleTracks,
    ...(cuesPosition !== undefined ? { cuesPosition } : {}),
    ...(firstClusterPosition !== undefined ? { firstClusterPosition } : {}),
  };
};

const parseSubtitleTrackEntry = (
  bytes: Uint8Array,
  entry: ElementHeader,
): MatroskaSubtitleTrack | undefined => {
  const entryEnd = entry.dataEnd;
  if (entryEnd === undefined) return undefined;
  let trackNumber: number | undefined;
  let trackType: number | undefined;
  let codecId: string | undefined;
  let name: string | undefined;
  let language: string | undefined;
  let languageBcp47: string | undefined;
  let isDefault = true;
  let isForced = false;
  let defaultDurationNs: number | undefined;
  let encoding: MatroskaContentEncoding = { kind: 'none' };
  forEachElement(bytes, entry.dataStart, entryEnd, (element) => {
    if (element.dataEnd === undefined || element.dataEnd > entryEnd) return;
    if (element.id === ID.trackNumber) trackNumber = readUnsigned(bytes, element);
    if (element.id === ID.trackType) trackType = readUnsigned(bytes, element);
    if (element.id === ID.codecId) codecId = readAscii(bytes, element)?.replace(/\0+$/, '');
    if (element.id === ID.name) name = readUtf8(bytes, element)?.trim();
    if (element.id === ID.language) language = readAscii(bytes, element)?.replace(/\0+$/, '');
    if (element.id === ID.languageBcp47) {
      languageBcp47 = readAscii(bytes, element)?.replace(/\0+$/, '');
    }
    if (element.id === ID.flagDefault) isDefault = readUnsigned(bytes, element) !== 0;
    if (element.id === ID.flagForced) isForced = readUnsigned(bytes, element) === 1;
    if (element.id === ID.defaultDuration) defaultDurationNs = readUnsigned(bytes, element);
    if (element.id === ID.contentEncodings) encoding = parseContentEncodings(bytes, element);
  });
  if (trackNumber === undefined || trackType !== SUBTITLE_TRACK_TYPE || !codecId) return undefined;
  const resolvedLanguage = languageBcp47 || language;
  return {
    trackNumber,
    codecId,
    codec: CODEC_BY_ID[codecId] ?? codecId.toLowerCase(),
    isDefault,
    isForced,
    encoding,
    ...(resolvedLanguage && resolvedLanguage !== 'und' ? { language: resolvedLanguage } : {}),
    ...(name ? { name } : {}),
    ...(defaultDurationNs ? { defaultDurationNs } : {}),
  };
};

const parseContentEncodings = (
  bytes: Uint8Array,
  encodings: ElementHeader,
): MatroskaContentEncoding => {
  const end = encodings.dataEnd;
  if (end === undefined) return { kind: 'unsupported' };
  const found: MatroskaContentEncoding[] = [];
  forEachElement(bytes, encodings.dataStart, end, (encoding) => {
    if (encoding.id !== ID.contentEncoding || encoding.dataEnd === undefined) return;
    const encodingEnd = encoding.dataEnd;
    let scope = 1;
    let type = 0;
    let algorithm = 0;
    let settings: Uint8Array | undefined;
    forEachElement(bytes, encoding.dataStart, encodingEnd, (child) => {
      if (child.dataEnd === undefined || child.dataEnd > encodingEnd) return;
      if (child.id === ID.contentEncodingScope) scope = readUnsigned(bytes, child) ?? scope;
      if (child.id === ID.contentEncodingType) type = readUnsigned(bytes, child) ?? type;
      if (child.id === ID.contentCompression) {
        const compressionEnd = child.dataEnd;
        forEachElement(bytes, child.dataStart, compressionEnd, (field) => {
          if (field.dataEnd === undefined || field.dataEnd > compressionEnd) return;
          if (field.id === ID.contentCompAlgo) algorithm = readUnsigned(bytes, field) ?? algorithm;
          if (field.id === ID.contentCompSettings) {
            settings = bytes.slice(field.dataStart, field.dataEnd);
          }
        });
      }
    });
    // Scope 第 1 位表示作用于帧内容；只作用于 CodecPrivate 的编码不影响字幕块。
    if ((scope & 1) === 0) return;
    if (type !== 0) found.push({ kind: 'unsupported' });
    else if (algorithm === 0) found.push({ kind: 'zlib' });
    else if (algorithm === 3 && settings) {
      found.push({ kind: 'header-stripping', prefix: settings });
    } else found.push({ kind: 'unsupported' });
  });
  if (found.length === 0) return { kind: 'none' };
  // 多层编码的叠加顺序少见且容易出错，按不支持处理。
  if (found.length > 1) return { kind: 'unsupported' };
  return found[0] ?? { kind: 'none' };
};

/** 读取 Cues，得到可用于定位与重新对齐的簇位置。 */
export const readMatroskaCuePoints = async (
  reader: RangeReader,
  layout: MatroskaSubtitleLayout,
): Promise<readonly MatroskaCuePoint[]> => {
  if (layout.cuesPosition === undefined) return [];
  const headerBytes = await reader.read(
    layout.cuesPosition,
    Math.min(layout.segmentEnd, layout.cuesPosition + MAX_ELEMENT_HEADER_BYTES),
  );
  const header = readElementHeader(headerBytes, 0);
  if (header?.id !== ID.cues || header.dataEnd === undefined) return [];
  const size = header.dataEnd - header.dataStart;
  if (size <= 0 || size > MAX_CUES_BYTES) return [];
  const dataStart = layout.cuesPosition + header.dataStart;
  const data = await reader.read(dataStart, Math.min(layout.segmentEnd, dataStart + size));
  return parseCuePoints(data, layout.segmentDataStart);
};

export const parseCuePoints = (data: Uint8Array, segmentDataStart: number): MatroskaCuePoint[] => {
  const result: MatroskaCuePoint[] = [];
  forEachElement(data, 0, data.length, (point) => {
    if (point.id !== ID.cuePoint || point.dataEnd === undefined) return;
    const pointEnd = point.dataEnd;
    let timeTicks: number | undefined;
    const positions: { track: number | undefined; cluster: number | undefined }[] = [];
    forEachElement(data, point.dataStart, pointEnd, (child) => {
      if (child.dataEnd === undefined || child.dataEnd > pointEnd) return;
      if (child.id === ID.cueTime) timeTicks = readUnsigned(data, child);
      if (child.id !== ID.cueTrackPositions) return;
      const childEnd = child.dataEnd;
      const position: { track: number | undefined; cluster: number | undefined } = {
        track: undefined,
        cluster: undefined,
      };
      forEachElement(data, child.dataStart, childEnd, (field) => {
        if (field.dataEnd === undefined || field.dataEnd > childEnd) return;
        if (field.id === ID.cueTrack) position.track = readUnsigned(data, field);
        if (field.id === ID.cueClusterPosition) position.cluster = readUnsigned(data, field);
      });
      positions.push(position);
    });
    if (timeTicks === undefined) return;
    for (const position of positions) {
      if (position.track === undefined || position.cluster === undefined) continue;
      result.push({
        timeTicks,
        track: position.track,
        clusterPosition: segmentDataStart + position.cluster,
      });
    }
  });
  return result.sort((left, right) => left.timeTicks - right.timeTicks);
};

export interface MatroskaBlockFrames {
  track: number;
  relativeTimestamp: number;
  frames: Uint8Array[];
}

/**
 * 解析 Block/SimpleBlock 负载：轨道号、相对时间与帧。支持无 lacing、Xiph、固定长度和
 * EBML lacing；结构不自洽时返回 undefined，调用方丢弃该块。
 */
export const parseMatroskaBlock = (data: Uint8Array): MatroskaBlockFrames | undefined => {
  const track = readVint(data, 0, false);
  if (!track || track.value === undefined) return undefined;
  let offset = track.length;
  if (offset + 3 > data.length) return undefined;
  const view = new DataView(data.buffer, data.byteOffset + offset, 3);
  const relativeTimestamp = view.getInt16(0);
  const flags = view.getUint8(2);
  offset += 3;
  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) {
    return { track: track.value, relativeTimestamp, frames: [data.subarray(offset)] };
  }
  const countByte = data[offset];
  if (countByte === undefined) return undefined;
  const frameCount = countByte + 1;
  offset += 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let index = 0; index < frameCount - 1; index++) {
      let size = 0;
      let byte: number | undefined;
      do {
        byte = data[offset++];
        if (byte === undefined) return undefined;
        size += byte;
      } while (byte === 0xff);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    const firstSize = readVint(data, offset, false);
    if (!firstSize || firstSize.value === undefined) return undefined;
    offset += firstSize.length;
    sizes.push(firstSize.value);
    for (let index = 1; index < frameCount - 1; index++) {
      const delta = readVint(data, offset, false);
      if (!delta || delta.value === undefined) return undefined;
      offset += delta.length;
      // EBML lacing 的差值是有符号 vint：减去 2^(7n-1)-1 得到真实差值。
      const bias = 2 ** (7 * delta.length - 1) - 1;
      const previous = sizes[sizes.length - 1] ?? 0;
      sizes.push(previous + delta.value - bias);
    }
  }
  const remaining = data.length - offset;
  if (lacing === 2) {
    if (remaining % frameCount !== 0) return undefined;
    for (let index = 0; index < frameCount - 1; index++) sizes.push(remaining / frameCount);
  }
  const explicit = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.some((size) => size < 0) || explicit > remaining) return undefined;
  sizes.push(remaining - explicit);
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    frames.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return { track: track.value, relativeTimestamp, frames };
};

export interface MatroskaSubtitleExtraction {
  /** 只读取视频流已经读过的字节；字幕读取器自己的读取不计入覆盖。 */
  read(start: number, end: number, signal: AbortSignal): Promise<Uint8Array>;
  coverage: ByteCoverage;
  layout: MatroskaSubtitleLayout;
  cuePoints: readonly MatroskaCuePoint[];
  track: MatroskaSubtitleTrack;
  startSeconds: number;
  videoTrackNumber?: number;
  sink: Pick<SubtitleCueSink, 'cues'>;
  signal: AbortSignal;
}

/**
 * 跟在视频流后面逐簇读取字幕块。起点取视频轨索引中不晚于起播时间的最后一个簇；
 * 视频流跳过当前位置时，按索引里已被读过的下一个簇重新对齐，从不读取未覆盖的字节。
 */
export const extractMatroskaSubtitles = async (options: MatroskaSubtitleExtraction) => {
  const { layout, coverage, signal, track } = options;
  const format = textFormat(track.codec);
  if (!format) throw new MatroskaSubtitleUnavailableError('unsupported_codec');
  if (track.encoding.kind === 'unsupported') {
    throw new MatroskaSubtitleUnavailableError('unsupported_encoding');
  }
  const scaleSeconds = layout.timestampScale / 1e9;
  const initial = startPosition(options);
  if (initial === undefined) throw new MatroskaSubtitleUnavailableError('no_index');
  let position = initial;
  const resyncPositions = [...new Set(options.cuePoints.map((cue) => cue.clusterPosition))].sort(
    (left, right) => left - right,
  );

  /**
   * 等待 [start, end) 被视频流读过。返回 false 表示已改到新位置：当前位置整段没被读、而索引里
   * 更靠后的簇已被读过时，按索引重新对齐；簇头读过但数据没被读、下一个元素却已被读时，说明
   * 解封装器复用了它在更早代次（例如描述阶段）自行缓存的簇，跳过这个簇而不去读未覆盖的字节。
   */
  const waitForCoverage = async (start: number, end: number, elementEnd?: number) => {
    while (!coverage.covers(start, end)) {
      if (!coverage.covers(start, start + 1)) {
        const next = coverage.firstCoveredAfter(start, resyncPositions);
        if (next !== undefined) {
          position = next;
          return false;
        }
      } else if (elementEnd !== undefined && coverage.covers(elementEnd, elementEnd + 1)) {
        position = elementEnd;
        return false;
      }
      await coverage.changed(signal);
    }
    return true;
  };

  while (position < layout.segmentEnd) {
    if (signal.aborted) throw signal.reason;
    const headerEnd = Math.min(layout.segmentEnd, position + MAX_ELEMENT_HEADER_BYTES);
    if (!(await waitForCoverage(position, headerEnd))) continue;
    const headerBytes = await options.read(position, headerEnd, signal);
    const header = readElementHeader(headerBytes, 0);
    if (!header || header.dataEnd === undefined) return;
    const dataStart = position + header.dataStart;
    const dataEnd = position + header.dataEnd;
    // 簇之后的 Cues、Tags 等元素说明簇已结束。
    if (header.id !== ID.cluster) return;
    if (!(await waitForCoverage(position, dataEnd, dataEnd))) continue;
    const cues = await scanCluster(options, format, dataStart, dataEnd, scaleSeconds);
    if (cues.length > 0 && !signal.aborted) options.sink.cues(cues);
    position = dataEnd;
  }
};

const startPosition = (options: MatroskaSubtitleExtraction): number | undefined => {
  const startTicks = (options.startSeconds * 1e9) / options.layout.timestampScale;
  const videoCues = options.cuePoints.filter((cue) => cue.track === options.videoTrackNumber);
  const candidates = videoCues.length > 0 ? videoCues : options.cuePoints;
  let chosen: MatroskaCuePoint | undefined;
  for (const cue of candidates) {
    if (cue.timeTicks > startTicks) break;
    chosen = cue;
  }
  if (chosen) return chosen.clusterPosition;
  if (options.startSeconds <= 0) {
    return options.layout.firstClusterPosition ?? candidates[0]?.clusterPosition;
  }
  return candidates[0]?.clusterPosition;
};

const scanCluster = async (
  options: MatroskaSubtitleExtraction,
  format: TextSubtitleFormat,
  dataStart: number,
  dataEnd: number,
  scaleSeconds: number,
): Promise<SubtitleCue[]> => {
  const window = new ClusterWindow(options, dataEnd);
  const cues: SubtitleCue[] = [];
  let clusterTimestamp: number | undefined;
  let offset = dataStart;
  while (offset < dataEnd) {
    const bytes = await window.at(offset, MAX_ELEMENT_HEADER_BYTES + 8);
    const header = readElementHeader(bytes, 0);
    if (!header || header.dataEnd === undefined) break;
    const childDataStart = offset + header.dataStart;
    const childDataEnd = offset + header.dataEnd;
    if (childDataEnd > dataEnd) break;
    if (header.id === ID.timestamp) {
      const value = await window.at(childDataStart, childDataEnd - childDataStart);
      clusterTimestamp = readUnsigned(value, {
        id: header.id,
        elementStart: 0,
        dataStart: 0,
        dataEnd: childDataEnd - childDataStart,
      });
    } else if (header.id === ID.simpleBlock || header.id === ID.blockGroup) {
      const cue = await readSubtitleBlock(
        window,
        options,
        format,
        header.id === ID.blockGroup,
        childDataStart,
        childDataEnd,
        clusterTimestamp,
        scaleSeconds,
      );
      if (cue) cues.push(cue);
    }
    offset = childDataEnd;
  }
  return cues;
};

const readSubtitleBlock = async (
  window: ClusterWindow,
  options: MatroskaSubtitleExtraction,
  format: TextSubtitleFormat,
  grouped: boolean,
  dataStart: number,
  dataEnd: number,
  clusterTimestamp: number | undefined,
  scaleSeconds: number,
): Promise<SubtitleCue | undefined> => {
  if (clusterTimestamp === undefined) return undefined;
  // 先只看轨道号，视频和音频块不读取负载。
  const peek = await window.at(dataStart, Math.min(dataEnd - dataStart, 32));
  let blockBytes: Uint8Array;
  let durationTicks: number | undefined;
  if (grouped) {
    const inner = readElementHeader(peek, 0);
    if (inner?.id === ID.block && !matchesTrack(peek, inner.dataStart, options.track)) {
      return undefined;
    }
    if (dataEnd - dataStart > MAX_SUBTITLE_BLOCK_BYTES) return undefined;
    const group = await window.at(dataStart, dataEnd - dataStart);
    let block: Uint8Array | undefined;
    forEachElement(group, 0, group.length, (child) => {
      if (child.dataEnd === undefined) return;
      if (child.id === ID.block) block = group.subarray(child.dataStart, child.dataEnd);
      if (child.id === ID.blockDuration) durationTicks = readUnsigned(group, child);
    });
    if (!block) return undefined;
    blockBytes = block;
  } else {
    if (!matchesTrack(peek, 0, options.track)) return undefined;
    if (dataEnd - dataStart > MAX_SUBTITLE_BLOCK_BYTES) return undefined;
    blockBytes = await window.at(dataStart, dataEnd - dataStart);
  }
  const parsed = parseMatroskaBlock(blockBytes);
  // 字幕块几乎不会 lacing；多帧共用一个时间戳时语义不明，丢弃而不是猜测显示方式。
  if (!parsed || parsed.track !== options.track.trackNumber || parsed.frames.length !== 1) {
    return undefined;
  }
  const frame = parsed.frames[0];
  if (!frame) return undefined;
  const payload = await decodeFrame(frame, options.track.encoding);
  const normalized = normalizeSubtitleText(
    new TextDecoder('utf-8', { fatal: false }).decode(payload),
    format,
  );
  if (!normalized) return undefined;
  const startTicks = clusterTimestamp + parsed.relativeTimestamp;
  const startSeconds = startTicks * scaleSeconds;
  // 结束时间按刻度相加后再换算，避免浮点累加误差。
  const endSeconds =
    durationTicks !== undefined
      ? (startTicks + durationTicks) * scaleSeconds
      : startSeconds +
        (options.track.defaultDurationNs !== undefined
          ? options.track.defaultDurationNs / 1e9
          : FALLBACK_CUE_SECONDS);
  if (!(endSeconds > startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0) {
    return undefined;
  }
  return {
    startSeconds,
    endSeconds,
    text: normalized.text,
    ...(normalized.placement ? { placement: normalized.placement } : {}),
  };
};

const matchesTrack = (bytes: Uint8Array, offset: number, track: MatroskaSubtitleTrack) =>
  readVint(bytes, offset, false)?.value === track.trackNumber;

const decodeFrame = async (
  frame: Uint8Array,
  encoding: MatroskaContentEncoding,
): Promise<Uint8Array> => {
  if (encoding.kind === 'header-stripping') {
    const joined = new Uint8Array(encoding.prefix.length + frame.length);
    joined.set(encoding.prefix, 0);
    joined.set(frame, encoding.prefix.length);
    return joined;
  }
  if (encoding.kind !== 'zlib') return frame;
  try {
    const stream = new Blob([frame as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new MatroskaSubtitleUnavailableError('unsupported_encoding');
  }
};

const textFormat = (codec: string): TextSubtitleFormat | undefined =>
  codec === 'srt' ? 'srt' : codec === 'webvtt' ? 'webvtt' : undefined;

/** 按窗口读取簇内字节，头部与字幕负载通常落在同一窗口，避免逐元素发起读取。 */
class ClusterWindow {
  private start = 0;
  private bytes: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly options: MatroskaSubtitleExtraction,
    private readonly end: number,
  ) {}

  async at(offset: number, length: number): Promise<Uint8Array> {
    const wanted = Math.min(this.end, offset + length);
    if (offset >= this.start && wanted <= this.start + this.bytes.length) {
      return this.bytes.subarray(offset - this.start, wanted - this.start);
    }
    const windowEnd = Math.min(this.end, Math.max(wanted, offset + CLUSTER_SCAN_WINDOW_BYTES));
    this.bytes = await this.options.read(offset, windowEnd, this.options.signal);
    this.start = offset;
    return this.bytes.subarray(0, wanted - offset);
  }
}
