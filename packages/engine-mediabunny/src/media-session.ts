import type {
  AudioMediaTrack,
  ByteSource,
  HdrConfiguration,
  MediaColorSpace,
  MediaDescriptor,
  MediaEngineCodecPreparation,
  MediaEngineSession,
  MediaFragmentSink,
  MediaFragmentStream,
  MediaFragmentStreamOptions,
  MediaTrack,
  MediaTrackBase,
  Rational,
  SubtitleMediaTrack,
  VideoMediaTrack,
} from '@shimweave/contracts';
import {
  ALL_FORMATS,
  Input,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
} from 'mediabunny';
import {
  copyDecoderDescription,
  fingerprintBytes,
  inferHdrConfiguration,
  parseCodecMetadata,
  selectCodecParameterString,
} from './codec-metadata.js';
import { ensureAudioCodecSupport } from './codec-support.js';
import { startMediaFragmentStream } from './fragment-stream.js';
import {
  type IsobmffDolbyVisionTrackMetadata,
  readIsobmffDolbyVisionTrackMetadata,
} from './isobmff-dolby-vision.js';
import { type MatroskaTrackMetadata, readMatroskaTrackMetadata } from './matroska-hdr.js';
import { MediabunnyByteSourceAdapter } from './source-adapter.js';

/**
 * MediabunnyMediaSession 绑定一个媒体输入生命周期。部分容器缺少 decoder config 时，
 * codec、色彩和 HDR 查询可能受限读取首个编码包，但不会扫描整段媒体。
 */
export class MediabunnyMediaSession implements MediaEngineSession {
  private readonly adapter: MediabunnyByteSourceAdapter;
  private readonly input: Input;
  private descriptorPromise: Promise<MediaDescriptor> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly bytes: ByteSource) {
    this.adapter = new MediabunnyByteSourceAdapter(bytes);
    this.input = new Input({ source: this.adapter.source, formats: ALL_FORMATS });
  }

  describe(): Promise<MediaDescriptor> {
    if (this.closePromise) return Promise.reject(new MediabunnyMediaSessionClosedError());
    if (!this.descriptorPromise) {
      const pending = this.readDescriptor();
      this.descriptorPromise = pending.catch((error: unknown) => {
        this.descriptorPromise = undefined;
        throw error;
      });
    }
    return this.descriptorPromise;
  }

  async prepareCodecs(preparation: MediaEngineCodecPreparation): Promise<void> {
    const descriptor = await this.describe();
    const audioTracks = descriptor.tracks.filter((track) => track.kind === 'audio');
    const audio = preparation.audioTrackId
      ? audioTracks.find((track) => track.id === preparation.audioTrackId)
      : (audioTracks.find((track) => track.isDefault) ?? audioTracks[0]);
    await ensureAudioCodecSupport(audio?.codec, preparation.outputAudio);
  }

  async startFragmentStream(
    sink: MediaFragmentSink,
    options: MediaFragmentStreamOptions = {},
  ): Promise<MediaFragmentStream> {
    if (this.closePromise) throw new MediabunnyMediaSessionClosedError();
    return startMediaFragmentStream(this.input, sink, options);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.input.dispose();
    this.closePromise = this.adapter.close();
    return this.closePromise;
  }

  private async readDescriptor(): Promise<MediaDescriptor> {
    const [format, tracks, sizeBytes] = await Promise.all([
      this.input.getFormat(),
      this.input.getTracks(),
      this.adapter.getSize(),
    ]);
    const container = format.name.toLowerCase();
    const internalCodecIds = await Promise.all(tracks.map((track) => track.getInternalCodecId()));
    const needsDolbyVisionBoxProbe =
      container === 'mp4' &&
      internalCodecIds.some(
        (codec) => typeof codec === 'string' && ['dvh1', 'dvhe'].includes(codec.toLowerCase()),
      );
    const [duration, mappedTracks, matroskaTracks, isobmffDolbyVisionTracks] = await Promise.all([
      this.input.getDurationFromMetadata(tracks, { skipLiveWait: true }),
      Promise.all(tracks.map((track) => describeTrack(track, container !== 'matroska'))),
      container === 'matroska'
        ? readMatroskaTrackMetadata(this.adapter, sizeBytes).catch(
            () => new Map<number, MatroskaTrackMetadata>(),
          )
        : Promise.resolve(new Map<number, MatroskaTrackMetadata>()),
      needsDolbyVisionBoxProbe
        ? readIsobmffDolbyVisionTrackMetadata(this.adapter, sizeBytes).catch(
            () => new Map<number, IsobmffDolbyVisionTrackMetadata>(),
          )
        : Promise.resolve(new Map<number, IsobmffDolbyVisionTrackMetadata>()),
    ]);
    const descriptor: MediaDescriptor = {
      sourceId: this.bytes.sourceId,
      sizeBytes,
      container,
      mimeType: format.mimeType,
      tracks: mappedTracks.map((track) => {
        if (track.kind !== 'video') return track;
        return mergeSupplementalVideoMetadata(
          track,
          matroskaTracks.get(Number(track.id)),
          isobmffDolbyVisionTracks.get(Number(track.id)),
        );
      }),
    };
    if (duration !== null && Number.isFinite(duration) && duration >= 0) {
      descriptor.durationSeconds = duration;
    }
    return descriptor;
  }
}

const FRAME_RATE_PROBE_PACKET_COUNT = 256;

export class MediabunnyMediaSessionClosedError extends Error {
  constructor() {
    super('Mediabunny media session is closed');
    this.name = 'MediabunnyMediaSessionClosedError';
  }
}

const describeTrack = async (track: InputTrack, probeFrameRate: boolean): Promise<MediaTrack> => {
  const [codec, codecString, language, title, bitrate, peakBitrate, disposition] =
    await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getLanguageCode(),
      track.getName(),
      track.getAverageBitrate(),
      track.getBitrate(),
      track.getDisposition(),
    ]);
  const base: MediaTrackBase = {
    id: String(track.id),
    kind: track.type,
    codec: codec ?? normalizeInternalCodec(await track.getInternalCodecId()),
    isDefault: disposition.default || disposition.primary,
    isForced: disposition.forced,
    ...(codecString ? { codecString } : {}),
    ...(language !== 'und' ? { language } : {}),
    ...(title ? { title } : {}),
    ...(validRate(bitrate) ? { bitrate } : validRate(peakBitrate) ? { bitrate: peakBitrate } : {}),
    ...(validRate(peakBitrate) ? { peakBitrate } : {}),
  };

  if (track.isVideoTrack()) return describeVideoTrack(track, base, probeFrameRate);
  if (track.isAudioTrack()) return describeAudioTrack(track, base);
  return { ...base, kind: 'subtitle' } satisfies SubtitleMediaTrack;
};

const mergeSupplementalVideoMetadata = (
  track: VideoMediaTrack,
  matroska: MatroskaTrackMetadata | undefined,
  isobmff: IsobmffDolbyVisionTrackMetadata | undefined,
): VideoMediaTrack => {
  if (!matroska && !isobmff) return track;
  const parsed = isobmff
    ? parseCodecMetadata(isobmff.codecString, isobmff.decoderDescription)
    : undefined;
  const hdr = isobmff?.hdr ?? matroska?.hdr;
  return {
    ...track,
    ...(isobmff?.codecString && !track.codecString ? { codecString: isobmff.codecString } : {}),
    ...(parsed?.profile && !track.profile ? { profile: parsed.profile } : {}),
    ...(parsed?.level && !track.level ? { level: parsed.level } : {}),
    ...(isobmff?.bitDepth !== undefined && track.bitDepth === undefined
      ? { bitDepth: isobmff.bitDepth }
      : {}),
    ...(isobmff?.chromaSubsampling && !track.chromaSubsampling
      ? { chromaSubsampling: isobmff.chromaSubsampling }
      : {}),
    ...(matroska?.frameRate && !track.frameRate ? { frameRate: matroska.frameRate } : {}),
    ...(hdr ? { hdr: mergeHdrConfiguration(track.hdr, hdr) } : {}),
    ...(isobmff?.decoderDescription && !track.decoderDescription
      ? {
          decoderDescription: isobmff.decoderDescription,
          decoderDescriptionHash: fingerprintBytes(isobmff.decoderDescription),
        }
      : {}),
  };
};

const mergeHdrConfiguration = (
  detected: HdrConfiguration | undefined,
  supplemental: HdrConfiguration,
): HdrConfiguration => {
  if (supplemental.kind === 'dolby-vision') return { ...detected, ...supplemental };
  if (detected?.kind === 'dolby-vision') return { ...supplemental, ...detected };
  return { ...detected, ...supplemental, kind: detected?.kind ?? supplemental.kind };
};

const describeVideoTrack = async (
  track: InputVideoTrack,
  base: MediaTrackBase,
  probeFrameRate: boolean,
): Promise<VideoMediaTrack> => {
  const [
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    highDynamicRange,
    rawColorSpace,
    config,
    frameRate,
  ] = await Promise.all([
    track.getCodedWidth(),
    track.getCodedHeight(),
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.hasHighDynamicRange(),
    track.getColorSpace(),
    track.getDecoderConfig(),
    probeFrameRate ? readFrameRate(track) : undefined,
  ]);
  const decoderDescription = copyDecoderDescription(config?.description);
  const codecString = selectCodecParameterString(base.codecString, config?.codec);
  const parsed = parseCodecMetadata(codecString, decoderDescription);
  const colorSpace = normalizeColorSpace(rawColorSpace);
  const hdr = parsed.hdr ?? inferHdrConfiguration(codecString, colorSpace, highDynamicRange);
  return {
    ...base,
    kind: 'video',
    ...(codecString ? { codecString } : {}),
    ...(positiveDimension(codedWidth) ? { codedWidth } : {}),
    ...(positiveDimension(codedHeight) ? { codedHeight } : {}),
    ...(positiveDimension(displayWidth) ? { displayWidth } : {}),
    ...(positiveDimension(displayHeight) ? { displayHeight } : {}),
    ...(frameRate ? { frameRate } : {}),
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.level ? { level: parsed.level } : {}),
    ...(parsed.tier ? { tier: parsed.tier } : {}),
    ...(parsed.bitDepth !== undefined ? { bitDepth: parsed.bitDepth } : {}),
    ...(parsed.chromaSubsampling ? { chromaSubsampling: parsed.chromaSubsampling } : {}),
    ...(colorSpace ? { colorSpace } : {}),
    ...(hdr ? { hdr } : {}),
    ...(decoderDescription
      ? {
          decoderDescription,
          decoderDescriptionHash: fingerprintBytes(decoderDescription),
        }
      : {}),
  };
};

/** 帧率以 256 个包为采样目标；编码重排可能要求少量额外包，失败不阻止转封装。 */
const readFrameRate = async (track: InputVideoTrack): Promise<Rational | undefined> => {
  try {
    const metrics = await track.computeFrameRateMetrics({
      targetPacketCount: FRAME_RATE_PROBE_PACKET_COUNT,
    });
    return rationalFrameRate(metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate);
  } catch {
    return undefined;
  }
};

const rationalFrameRate = (value: number): Rational | undefined => {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const commonRates: readonly Rational[] = [
    { numerator: 24_000, denominator: 1_001 },
    { numerator: 24, denominator: 1 },
    { numerator: 25, denominator: 1 },
    { numerator: 30_000, denominator: 1_001 },
    { numerator: 30, denominator: 1 },
    { numerator: 50, denominator: 1 },
    { numerator: 60_000, denominator: 1_001 },
    { numerator: 60, denominator: 1 },
    { numerator: 120_000, denominator: 1_001 },
    { numerator: 120, denominator: 1 },
  ];
  const common = commonRates.find(
    (rate) => Math.abs(rate.numerator / rate.denominator - value) <= 0.001,
  );
  if (common) return common;

  const denominator = 1_000;
  const numerator = Math.round(value * denominator);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
};

const describeAudioTrack = async (
  track: InputAudioTrack,
  base: MediaTrackBase,
): Promise<AudioMediaTrack> => {
  const [channels, sampleRate] = await Promise.all([
    track.getNumberOfChannels(),
    track.getSampleRate(),
  ]);
  const parsed = parseCodecMetadata(base.codecString, undefined);
  return {
    ...base,
    kind: 'audio',
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(positiveDimension(channels) ? { channels } : {}),
    ...(positiveDimension(sampleRate) ? { sampleRate } : {}),
  };
};

const normalizeInternalCodec = (value: string | number | Uint8Array | null): string => {
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number') return String(value);
  return value ? 'unknown-binary' : 'unknown';
};

const normalizeColorSpace = (value: VideoColorSpaceInit): MediaColorSpace | undefined => {
  const colorSpace: MediaColorSpace = {};
  if (value.fullRange !== undefined && value.fullRange !== null) {
    colorSpace.fullRange = value.fullRange;
  }
  if (value.matrix) colorSpace.matrix = value.matrix;
  if (value.primaries) colorSpace.primaries = value.primaries;
  if (value.transfer) colorSpace.transfer = value.transfer;
  return Object.keys(colorSpace).length > 0 ? colorSpace : undefined;
};

const validRate = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

const positiveDimension = (value: number): boolean => Number.isFinite(value) && value > 0;
