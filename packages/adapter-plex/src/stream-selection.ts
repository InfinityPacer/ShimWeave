import type { MediaTrack } from '@shimweave/contracts';
import type { PlexTimelineContext } from './timeline.js';

/**
 * Plex 为当前用户记住的音轨选择。ordinal 是该音轨在 Part 全部音轨中按容器顺序的位置，
 * 与媒体引擎按容器顺序列出的音轨一一对应；codec 与 language 用于核对，不参与定位。
 */
export interface PlexAudioSelection {
  ordinal: number;
  codec?: string;
  language?: string;
}

/**
 * Plex 为当前用户记住的字幕选择。内嵌字幕带容器流索引，ordinal 是它在 Part 全部内嵌字幕中
 * 按容器顺序的位置；外挂字幕没有索引，只记为 external。
 */
export interface PlexSubtitleSelection {
  ordinal?: number;
  external?: boolean;
  codec?: string;
  language?: string;
}

export interface PlexStreamSelection {
  audio?: PlexAudioSelection;
  /** 缺失表示没有选字幕，播放时字幕保持关闭。 */
  subtitle?: PlexSubtitleSelection;
}

/** Plex 字幕选择对应到媒体引擎的结果；unavailable 表示选了字幕但不能确定是哪一条。 */
export type PlexSubtitleResolution =
  | { status: 'off' }
  | { status: 'track'; trackId: string }
  | { status: 'unavailable'; reason: 'mismatch' | 'external'; codec?: string };

export interface PlexMetadataRequest {
  url: string;
  token: string;
}

/** 读取条目元数据的最小请求。Token 只通过请求头发送，不进入 URL。 */
export const createPlexMetadataRequest = (context: PlexTimelineContext): PlexMetadataRequest => {
  const url = new URL(context.metadataPath, context.origin);
  for (const [name, value] of context.clientParameters) url.searchParams.set(name, value);
  return { url: url.toString(), token: context.token };
};

/**
 * 从 `/library/metadata/{id}` 的 JSON 响应中取出指定 Media/Part 的选中音轨。
 * 结构不符或没有选中音轨时返回空选择，调用方按容器默认轨处理。
 */
export const parsePlexStreamSelection = (
  body: unknown,
  mediaIndex: number,
  partIndex: number,
): PlexStreamSelection => {
  const metadata = arrayItem(record(record(body)?.MediaContainer)?.Metadata, 0);
  const media = arrayItem(metadata?.Media, mediaIndex);
  const part = arrayItem(media?.Part, partIndex);
  const streams = Array.isArray(part?.Stream) ? part.Stream.filter(isRecord) : [];
  const audios = streams
    .filter((stream) => stream.streamType === 2 && Number.isSafeInteger(stream.index))
    .sort((left, right) => Number(left.index) - Number(right.index));
  const ordinal = audios.findIndex(isSelected);
  const selected = audios[ordinal];
  const subtitle = parseSubtitleSelection(streams);
  return {
    ...(selected ? { audio: { ordinal, ...streamFacts(selected) } } : {}),
    ...(subtitle ? { subtitle } : {}),
  };
};

const parseSubtitleSelection = (
  streams: readonly Record<string, unknown>[],
): PlexSubtitleSelection | undefined => {
  const subtitles = streams.filter((stream) => stream.streamType === 3);
  const selected = subtitles.find(isSelected);
  if (!selected) return undefined;
  if (!Number.isSafeInteger(selected.index)) return { external: true, ...streamFacts(selected) };
  const embedded = subtitles
    .filter((stream) => Number.isSafeInteger(stream.index))
    .sort((left, right) => Number(left.index) - Number(right.index));
  return { ordinal: embedded.indexOf(selected), ...streamFacts(selected) };
};

const isSelected = (stream: Record<string, unknown>): boolean =>
  stream.selected === true || stream.selected === 1;

const streamFacts = (stream: Record<string, unknown>): { codec?: string; language?: string } => {
  const codec = nonEmptyString(stream.codec);
  const language = nonEmptyString(stream.languageTag) ?? nonEmptyString(stream.languageCode);
  return {
    ...(codec ? { codec: codec.toLowerCase() } : {}),
    ...(language ? { language } : {}),
  };
};

/**
 * 把 Plex 的选择对应到媒体引擎列出的音轨。位置对得上但编码不一致时说明两边的轨道列表不同，
 * 返回 undefined 让调用方沿用默认轨，而不是冒险播放另一条音轨。
 */
export const resolvePlexAudioTrack = (
  tracks: readonly MediaTrack[],
  selection: PlexAudioSelection | undefined,
): string | undefined => {
  if (!selection) return undefined;
  const track = tracks.filter((candidate) => candidate.kind === 'audio')[selection.ordinal];
  if (!track) return undefined;
  if (selection.codec && !sameAudioCodec(selection.codec, track.codec)) return undefined;
  return track.id;
};

/**
 * 把 Plex 的字幕选择对应到媒体引擎列出的字幕轨：按内嵌字幕的位置定位，再核对编码。
 * 越界或编码不一致说明两边的轨道列表不同，返回 unavailable 让宿主提示，而不是显示另一条字幕。
 */
export const resolvePlexSubtitleTrack = (
  tracks: readonly MediaTrack[],
  selection: PlexSubtitleSelection | undefined,
): PlexSubtitleResolution => {
  if (!selection) return { status: 'off' };
  const codec = selection.codec ? { codec: selection.codec } : {};
  if (selection.external || selection.ordinal === undefined) {
    return { status: 'unavailable', reason: 'external', ...codec };
  }
  const track = tracks.filter((candidate) => candidate.kind === 'subtitle')[selection.ordinal];
  if (!track || (selection.codec && !sameSubtitleCodec(selection.codec, track.codec))) {
    return { status: 'unavailable', reason: 'mismatch', ...codec };
  }
  return { status: 'track', trackId: track.id };
};

const PLEX_SUBTITLE_CODEC_FAMILIES: Readonly<Record<string, string>> = {
  subrip: 'srt',
  vtt: 'webvtt',
  hdmv_pgs_subtitle: 'pgs',
  dvd_subtitle: 'vobsub',
  dvbsub: 'dvb_subtitle',
};

const sameSubtitleCodec = (plexCodec: string, trackCodec: string): boolean => {
  const family = (codec: string) =>
    PLEX_SUBTITLE_CODEC_FAMILIES[codec.toLowerCase()] ?? codec.toLowerCase();
  return family(plexCodec) === family(trackCodec);
};

/** Plex 与媒体引擎对同一编码的命名不同，这里只归一已知的差异。 */
const PLEX_CODEC_FAMILIES: Readonly<Record<string, string>> = {
  dca: 'dts',
  'dca-ma': 'dts',
  dts: 'dts',
  truehd: 'truehd',
  a_truehd: 'truehd',
  mlp: 'truehd',
  pcm: 'pcm',
};

const codecFamily = (codec: string): string => {
  const normalized = codec.toLowerCase();
  if (normalized.startsWith('pcm')) return 'pcm';
  return PLEX_CODEC_FAMILIES[normalized] ?? normalized;
};

const sameAudioCodec = (plexCodec: string, trackCodec: string): boolean =>
  codecFamily(plexCodec) === codecFamily(trackCodec);

const arrayItem = (value: unknown, index: number): Record<string, unknown> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const item: unknown = value[index];
  return isRecord(item) ? item : undefined;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
