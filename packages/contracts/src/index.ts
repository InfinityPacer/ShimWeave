/** 媒体容器和编码名称使用小写规范值，站点适配器不得写入客户端品牌名称。 */
export type MediaCodec = string;

export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface Rational {
  numerator: number;
  denominator: number;
}

export interface MediaColorSpace {
  fullRange?: boolean;
  matrix?: string;
  primaries?: string;
  transfer?: string;
}

export interface HdrConfiguration {
  kind: 'sdr' | 'hdr10' | 'hdr10-plus' | 'hlg' | 'dolby-vision' | 'hdr-unknown';
  profile?: number;
  level?: number;
  compatibilityId?: number;
  hasHdr10BaseLayer?: boolean;
  masteringDisplay?: string;
  maxContentLightLevel?: number;
  maxFrameAverageLightLevel?: number;
}

export interface MediaTrackBase {
  id: string;
  kind: TrackKind;
  codec: MediaCodec;
  /** 完整 RFC 6381 codec string，例如 hvc1.2.4.L153.B0。 */
  codecString?: string;
  language?: string;
  title?: string;
  /** 规划与 MediaCapabilities 使用平均码率；峰值单独保留用于诊断和缓冲预算。 */
  bitrate?: number;
  peakBitrate?: number;
  bitDepth?: number;
  isDefault?: boolean;
  isForced?: boolean;
}

export interface VideoMediaTrack extends MediaTrackBase {
  kind: 'video';
  profile?: string;
  level?: string;
  tier?: string;
  chromaSubsampling?: string;
  codedWidth?: number;
  codedHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  frameRate?: Rational;
  colorSpace?: MediaColorSpace;
  hdr?: HdrConfiguration;
  /** 运行时探测可使用原始 decoder description，持久身份只使用其摘要。 */
  decoderDescription?: Uint8Array;
  decoderDescriptionHash?: string;
}

export interface AudioMediaTrack extends MediaTrackBase {
  kind: 'audio';
  profile?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
}

export interface SubtitleMediaTrack extends MediaTrackBase {
  kind: 'subtitle';
}

export type MediaTrack = VideoMediaTrack | AudioMediaTrack | SubtitleMediaTrack;

export interface MediaDescriptor {
  /** 稳定的不透明内容身份，不能使用会过期的签名 URL。 */
  sourceId: string;
  /** 更强的源内容校验值，例如 ETag 或受限头尾摘要。 */
  sourceFingerprint?: string;
  sizeBytes?: number;
  container: string;
  mimeType?: string;
  durationSeconds?: number;
  tracks: readonly MediaTrack[];
}

export interface PlaybackIntent {
  media: MediaDescriptor;
  /** false 表示当前地址只能由可附加请求头的 ByteSource 读取，不能交给原生媒体元素。 */
  nativeSourceUrlAvailable?: boolean;
  preferredAudioTrackId?: string;
  preferredSubtitleTrackId?: string;
  startSeconds?: number;
}

/** 音频转换的确定性输出，能力判断和媒体引擎必须使用同一组参数。 */
export interface AudioTranscodeOutput {
  codec: 'aac';
  codecString: string;
  channels: number;
  channelLayout?: string;
  sampleRate: number;
  bitrate: number;
}

export interface CodecTransform {
  from: MediaCodec;
  to: MediaCodec;
  kind: 'audio' | 'video';
  outputAudio?: AudioTranscodeOutput;
}

export type SupportState = 'supported' | 'unsupported' | 'unknown';

/** 能力证据按播放数据路径隔离，不能跨路径投票或泛化。 */
export type PlaybackPath =
  | 'native-file'
  | 'mse-remux'
  | 'mse-remux-audio-transcode'
  | 'webcodecs-video';

export interface VideoConfiguration {
  codec: MediaCodec;
  codecString: string;
  profile?: string;
  level?: string;
  tier?: string;
  bitDepth?: number;
  chromaSubsampling?: string;
  codedWidth: number;
  codedHeight: number;
  displayWidth?: number;
  displayHeight?: number;
  frameRate?: Rational;
  bitrate?: number;
  colorSpace?: MediaColorSpace;
  hdr?: HdrConfiguration;
  decoderDescriptionHash?: string;
}

export interface AudioConfiguration {
  codec: MediaCodec;
  codecString: string;
  profile?: string;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  bitrate?: number;
  bitDepth?: number;
}

export interface ExactMediaConfiguration {
  container: string;
  mimeType: string;
  video: VideoConfiguration;
  audio?: AudioConfiguration;
}

export interface CapabilityScope {
  schemaVersion: number;
  /** 浏览器构建、操作系统与硬件能力组合的不透明身份。 */
  runtimeKey: string;
  /** 规划器、媒体引擎和 codec provider 版本组合的不透明身份。 */
  engineKey: string;
}

interface CapabilityEvidenceBase {
  path: PlaybackPath;
  configurationKey: string;
  observedAt: number;
}

export interface MseTypeEvidence extends CapabilityEvidenceBase {
  kind: 'mse-type';
  path: 'mse-remux' | 'mse-remux-audio-transcode';
  contentType: string;
  support: SupportState;
}

export interface VideoDecoderEvidence extends CapabilityEvidenceBase {
  kind: 'video-decoder';
  path: 'webcodecs-video';
  support: SupportState;
  recognizedConfigurationKey?: string;
}

export interface MediaCapabilitiesEvidence extends CapabilityEvidenceBase {
  kind: 'media-capabilities';
  path: 'native-file' | 'mse-remux' | 'mse-remux-audio-transcode';
  support: SupportState;
  smooth?: boolean;
  powerEfficient?: boolean;
}

interface SampleCapabilityEvidenceBase extends CapabilityEvidenceBase {
  kind: 'sample';
  mediaFingerprint: string;
}

export interface SupportedSampleCapabilityEvidence extends SampleCapabilityEvidenceBase {
  support: 'supported';
  milestone: 'first-frame' | 'steady-playback' | 'seek-resume';
}

export interface UnsupportedSampleCapabilityEvidence extends SampleCapabilityEvidenceBase {
  support: 'unsupported';
  failureClass: 'format' | 'decode' | 'append';
}

export interface TransientSampleCapabilityEvidence extends SampleCapabilityEvidenceBase {
  support: 'unknown';
  failureClass: 'network' | 'quota' | 'cancelled';
}

export type SampleCapabilityEvidence =
  | SupportedSampleCapabilityEvidence
  | UnsupportedSampleCapabilityEvidence
  | TransientSampleCapabilityEvidence;

export type CapabilityEvidence =
  | MseTypeEvidence
  | VideoDecoderEvidence
  | MediaCapabilitiesEvidence
  | SampleCapabilityEvidence;

/** 能力快照只保存可审计证据和项目实际提供的转换能力。 */
export interface CapabilitySnapshot {
  scope: CapabilityScope;
  evidence: readonly CapabilityEvidence[];
  remuxContainers: readonly string[];
  transforms: readonly CodecTransform[];
}

export interface MediaCapabilitiesProbeConfiguration {
  type: 'file' | 'media-source';
  video: {
    contentType: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
  };
  audio?: {
    contentType: string;
    channels?: string;
    bitrate?: number;
    samplerate?: number;
  };
}

export type CapabilityProbeRequest =
  | {
      kind: 'media-facts';
      fields: readonly ('video-codec-string' | 'video-dimensions' | 'audio-codec-string')[];
    }
  | {
      kind: 'mse-type';
      path: 'mse-remux' | 'mse-remux-audio-transcode';
      configurationKey: string;
      contentType: string;
    }
  | {
      kind: 'media-capabilities';
      path: 'native-file' | 'mse-remux' | 'mse-remux-audio-transcode';
      configurationKey: string;
      configuration: MediaCapabilitiesProbeConfiguration;
    }
  | {
      kind: 'video-decoder';
      path: 'webcodecs-video';
      configurationKey: string;
      configuration: {
        codec: string;
        codedWidth: number;
        codedHeight: number;
        description?: Uint8Array;
      };
    }
  | {
      kind: 'sample-playback';
      path: 'native-file' | 'mse-remux' | 'mse-remux-audio-transcode';
      configurationKey: string;
      mediaFingerprint: string;
    };

export type PlaybackStrategy = 'native' | 'remux' | 'remux-audio-transcode';

export interface PlaybackPlan {
  strategy: PlaybackStrategy;
  path: Exclude<PlaybackPath, 'webcodecs-video'>;
  configurationKey: string;
  mediaFingerprint: string;
  outputContainer?: string;
  videoTrackId: string;
  audioTrackId?: string;
  outputAudio?: AudioTranscodeOutput;
  subtitleTrackId?: string;
}

export type PlanningResult =
  | { status: 'ready'; plan: PlaybackPlan; evidence: readonly string[] }
  | {
      status: 'probe-required';
      candidate?: PlaybackPlan;
      probes: readonly CapabilityProbeRequest[];
    }
  | { status: 'unsupported'; reason: string; evidence: readonly string[] };

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * ByteSource 的 end 为开区间；实现必须支持取消且不得静默退化为整文件下载。
 * 返回的字节视图按不可变数据共享，调用方不得修改其内容。
 */
export interface ByteSource {
  /** sourceId 是稳定的不透明内容身份，不能直接使用会过期的签名 URL。 */
  readonly sourceId: string;
  getSize(signal?: AbortSignal): Promise<number>;
  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void> | void;
}

/** Fragment sink 提供带背压的单向媒体输出；实现必须等待 write 完成后再发送下一块。 */
export interface MediaFragmentSink {
  write(bytes: Uint8Array): Promise<void>;
  close?(): Promise<void> | void;
  abort?(reason: unknown): Promise<void> | void;
}

export interface MediaFragmentStreamOptions {
  /** fragmented MP4 的目标最小分片时长；较小值改善首帧但增加调度开销。 */
  minimumFragmentDuration?: number;
  /** 设置后仅按确定配置转码音频；视频仍必须保持原码流。 */
  outputAudio?: AudioTranscodeOutput;
  /** 选择要输出的视频轨道；省略时使用媒体引擎判定的主轨。 */
  videoTrackId?: string;
  /** 选择要输出的音频轨道；省略时使用媒体引擎判定的主轨。 */
  audioTrackId?: string;
  /** 从该媒体时间附近的关键帧重建时间轴，不得隐式触发视频转码。 */
  startSeconds?: number;
}

/** Fragment stream 使用原媒体绝对时间描述输出时间轴，取消必须可等待。 */
export interface MediaFragmentStream {
  mimeType: string;
  timelineOffsetSeconds: number;
  initialPositionSeconds: number;
  completion: Promise<void>;
  cancel(): Promise<void>;
}

export interface MediaEngineCodecPreparation {
  outputAudio: AudioTranscodeOutput;
  audioTrackId?: string;
}

/**
 * MediaEngineSession 绑定一个媒体输入生命周期。实现必须允许 describe 复用结果，
 * 并在 close 后停止读取、转换和分片输出。
 */
export interface MediaEngineSession {
  describe(): Promise<MediaDescriptor>;
  prepareCodecs(preparation: MediaEngineCodecPreparation): Promise<void>;
  startFragmentStream(
    sink: MediaFragmentSink,
    options?: MediaFragmentStreamOptions,
  ): Promise<MediaFragmentStream>;
  close(): Promise<void>;
}

/** 媒体引擎只消费统一 ByteSource；源站解析、Range 调度和站点协议由宿主负责。 */
export interface MediaEngineProvider {
  createSession(source: ByteSource): MediaEngineSession;
}

/** 可直接读取的 HTTP Range 源；同一地址也可按需交给原生媒体元素。 */
export interface DirectHttpRangeAccess {
  kind: 'direct-http-range';
  url: string;
}

/**
 * 每次 Range 读取前先通过控制端点换取临时媒体地址。
 * 控制请求头只属于字节传输层，不得进入页面状态、日志或媒体源请求。
 */
export interface ControlledHttpRangeAccess {
  kind: 'controlled-http-range';
  url: string;
  requestHeaders: Readonly<Record<string, string>>;
  responseUrlHeader: string;
  expectedStatus?: number;
}

export type MediaSourceAccess = DirectHttpRangeAccess | ControlledHttpRangeAccess;

/**
 * 站点 provider 输出的最小媒体源契约。短期 URL 可进入专用 Worker，
 * 但 sourceId 必须是与签名生命周期无关的稳定内容身份。
 */
export interface MediaSourceDescriptor {
  sourceId: string;
  access: MediaSourceAccess;
  /** 仅在地址本身可直接交给 HTMLMediaElement 时提供。 */
  nativePlaybackUrl?: string;
}

export const isMediaSourceDescriptor = (value: unknown): value is MediaSourceDescriptor => {
  if (!isRecord(value) || !boundedString(value.sourceId, 2048) || !isRecord(value.access)) {
    return false;
  }
  if (value.nativePlaybackUrl !== undefined && !httpUrl(value.nativePlaybackUrl)) return false;
  if (value.access.kind === 'direct-http-range') return httpUrl(value.access.url);
  return (
    value.access.kind === 'controlled-http-range' &&
    httpUrl(value.access.url) &&
    isStringRecord(value.access.requestHeaders) &&
    boundedString(value.access.responseUrlHeader, 256) &&
    (value.access.expectedStatus === undefined || httpStatus(value.access.expectedStatus))
  );
};

/** provider 只识别并描述媒体源，不创建 Worker、执行探测或决定播放策略。 */
export interface MediaSourceProvider<TContext> {
  readonly id: string;
  resolve(context: TContext): MediaSourceDescriptor | undefined;
}

export interface SiteAdapterManifest {
  id: string;
  displayName: string;
  matchPatterns: readonly string[];
}

const boundedString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;

const httpUrl = (value: unknown): value is string => {
  if (!boundedString(value, 16_384)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const httpStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599;

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([name, headerValue]) => boundedString(name, 256) && boundedString(headerValue, 8192),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export * from './range-lease.js';
