import type {
  AudioTranscodeOutput,
  MediaFragmentSink,
  MediaFragmentStream,
  MediaFragmentStreamOptions,
} from '@shimweave/contracts';
import {
  AppendOnlyStreamTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  type Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

const MAX_TRACK_LEAD_SECONDS = 1;

export const startMediaFragmentStream = async (
  input: Input,
  sink: MediaFragmentSink,
  options: MediaFragmentStreamOptions = {},
): Promise<MediaFragmentStream> => {
  validateOptions(options);
  if ((options.startSeconds ?? 0) > 0) return startSeekRemux(input, sink, options);
  return startConversion(input, sink, options);
};

const startConversion = async (
  input: Input,
  sink: MediaFragmentSink,
  options: MediaFragmentStreamOptions,
): Promise<MediaFragmentStream> => {
  const output = createOutput(sink, options);
  const conversion = await Conversion.init({
    input,
    output,
    tracks: options.videoTrackId || options.audioTrackId ? 'all' : 'primary',
    video: options.videoTrackId
      ? (track) =>
          String(track.id) === options.videoTrackId ? { forceTranscode: false } : { discard: true }
      : { forceTranscode: false },
    audio: options.audioTrackId
      ? (track) =>
          String(track.id) === options.audioTrackId
            ? options.outputAudio
              ? audioConversionOptions(options.outputAudio)
              : { forceTranscode: false }
            : { discard: true }
      : options.outputAudio
        ? audioConversionOptions(options.outputAudio)
        : { forceTranscode: false },
    showWarnings: false,
  });
  if (!conversion.isValid) {
    await conversion.cancel();
    throw new MediabunnyConversionUnsupportedError(
      conversion.discardedTracks.map((item) => item.reason),
    );
  }

  const completion = conversion.execute();
  void completion.catch(() => undefined);
  try {
    const mimeType = await output.getMimeType();
    return {
      mimeType,
      timelineOffsetSeconds: 0,
      initialPositionSeconds: 0,
      completion,
      cancel: () => conversion.cancel(),
    };
  } catch (error) {
    await Promise.allSettled([conversion.cancel(), completion]);
    throw error;
  }
};

const startSeekRemux = async (
  input: Input,
  sink: MediaFragmentSink,
  options: MediaFragmentStreamOptions,
): Promise<MediaFragmentStream> => {
  const startSeconds = options.startSeconds ?? 0;
  const [duration, videoTrack, audioTrack] = await Promise.all([
    input.getDurationFromMetadata(),
    selectVideoTrack(input, options.videoTrackId),
    selectAudioTrack(input, options.audioTrackId),
  ]);
  if (duration !== null && startSeconds >= duration) {
    throw new MediabunnySeekOutOfRangeError(startSeconds, duration);
  }
  if (options.videoTrackId && !videoTrack) {
    throw new MediabunnyConversionUnsupportedError(['video_track_not_found']);
  }
  if (options.audioTrackId && !audioTrack) {
    throw new MediabunnyConversionUnsupportedError(['audio_track_not_found']);
  }
  if (!videoTrack && !audioTrack)
    throw new MediabunnyConversionUnsupportedError(['no_media_tracks']);

  const video = videoTrack ? await prepareVideoTrack(videoTrack, startSeconds) : undefined;
  const provisionalOffset = video?.startPacket.timestamp ?? startSeconds;
  const audio =
    audioTrack && !options.outputAudio
      ? await prepareAudioTrack(audioTrack, provisionalOffset)
      : undefined;
  const timelineOffsetSeconds =
    video?.startPacket.timestamp ?? audio?.startPacket.timestamp ?? provisionalOffset;
  const initialPositionSeconds = Math.max(0, startSeconds - timelineOffsetSeconds);
  const output = createOutput(sink, options);
  const lifetime = new AbortController();
  const trackBarrier = new TrackTimestampBarrier(lifetime.signal);
  if (video) trackBarrier.register('video');
  if (audioTrack) trackBarrier.register('audio');
  if (video) {
    const languageCode = normalizeOutputLanguageCode(video.languageCode);
    output.addVideoTrack(video.source, {
      ...(video.decoderConfig ? { decoderConfig: video.decoderConfig } : {}),
      rotation: video.rotation,
      ...(languageCode ? { languageCode } : {}),
      disposition: video.disposition,
      hasOnlyKeyPackets: video.hasOnlyKeyPackets,
    });
  }
  if (audio) {
    const languageCode = normalizeOutputLanguageCode(audio.languageCode);
    output.addAudioTrack(audio.source, {
      ...(audio.decoderConfig ? { decoderConfig: audio.decoderConfig } : {}),
      ...(languageCode ? { languageCode } : {}),
      disposition: audio.disposition,
    });
  }
  let audioConversion: Conversion | undefined;
  if (audioTrack && options.outputAudio) {
    try {
      audioConversion = await createSeekAudioConversion(
        input,
        output,
        audioTrack,
        timelineOffsetSeconds,
        options.outputAudio,
        trackBarrier,
      );
    } catch (error) {
      await output.cancel().catch(() => undefined);
      throw error;
    }
  }

  let outputCancellation: Promise<void> | undefined;
  const cancelOutput = (): Promise<void> => {
    outputCancellation ??= output.cancel();
    return outputCancellation;
  };
  let audioConversionCancellation: Promise<void> | undefined;
  const cancelAudioConversion = (): Promise<void> => {
    if (!audioConversion) return Promise.resolve();
    audioConversionCancellation ??= audioConversion.cancel();
    return audioConversionCancellation;
  };
  const completion = (async () => {
    const pumps: Promise<void>[] = [];
    try {
      await output.start();
      if (video) {
        pumps.push(
          pumpPackets(
            'video',
            video.sink.packets(video.startPacket, undefined, { verifyKeyPackets: true }),
            video.source,
            timelineOffsetSeconds,
            lifetime.signal,
            trackBarrier,
          ),
        );
      }
      if (audio) {
        pumps.push(
          pumpPackets(
            'audio',
            audio.sink.packets(audio.startPacket),
            audio.source,
            timelineOffsetSeconds,
            lifetime.signal,
            trackBarrier,
          ),
        );
      }
      if (audioConversion) {
        pumps.push(
          audioConversion.execute().finally(() => {
            trackBarrier.closeTrack('audio');
          }),
        );
      }
      await Promise.all(pumps);
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      await output.finalize();
    } catch (error) {
      if (!lifetime.signal.aborted) lifetime.abort(error);
      await Promise.allSettled(pumps);
      await cancelAudioConversion().catch(() => undefined);
      await cancelOutput().catch(() => undefined);
      throw error;
    } finally {
      trackBarrier.dispose();
    }
  })();
  void completion.catch(() => undefined);

  try {
    const mimeType = await output.getMimeType();
    return {
      mimeType,
      timelineOffsetSeconds,
      initialPositionSeconds,
      completion,
      cancel: async () => {
        if (!lifetime.signal.aborted) lifetime.abort(new MediabunnyFragmentStreamCancelledError());
        await Promise.allSettled([cancelAudioConversion(), cancelOutput()]);
      },
    };
  } catch (error) {
    lifetime.abort(error);
    await Promise.allSettled([cancelAudioConversion(), cancelOutput(), completion]);
    throw error;
  }
};

/** Seek 时只让 Conversion 驱动选中的音频轨，视频继续按关键帧复制原码流。 */
const createSeekAudioConversion = async (
  input: Input,
  output: Output<Mp4OutputFormat, AppendOnlyStreamTarget>,
  audioTrack: InputAudioTrack,
  timelineOffsetSeconds: number,
  outputAudio: AudioTranscodeOutput,
  trackBarrier: TrackTimestampBarrier,
): Promise<Conversion> => {
  const selectedTrackId = String(audioTrack.id);
  const conversion = await Conversion.init({
    input,
    output,
    composable: true,
    tracks: 'all',
    trim: { start: timelineOffsetSeconds },
    video: { discard: true },
    audio: (track) =>
      String(track.id) === selectedTrackId
        ? {
            ...audioConversionOptions(outputAudio),
          }
        : { discard: true },
    showWarnings: false,
  });
  conversion.onProgress = (_progress, convertedSeconds) => {
    trackBarrier.observe('audio', convertedSeconds);
  };
  if (!conversion.utilizedTracks.some((track) => String(track.id) === selectedTrackId)) {
    const reasons = conversion.discardedTracks
      .filter((item) => String(item.track.id) === selectedTrackId)
      .map((item) => item.reason);
    await conversion.cancel();
    throw new MediabunnyConversionUnsupportedError(
      reasons.length > 0 ? reasons : ['audio_track_not_convertible'],
    );
  }
  return conversion;
};

const createOutput = (
  sink: MediaFragmentSink,
  options: MediaFragmentStreamOptions,
): Output<Mp4OutputFormat, AppendOnlyStreamTarget> =>
  new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: options.minimumFragmentDuration ?? 1,
    }),
    target: new AppendOnlyStreamTarget(
      new WritableStream<Uint8Array>({
        write: (bytes) => sink.write(bytes),
        close: () => sink.close?.(),
        abort: (reason) => sink.abort?.(reason),
      }),
    ),
  });

const audioConversionOptions = (output: AudioTranscodeOutput) => ({
  codec: output.codec,
  numberOfChannels: output.channels,
  sampleRate: output.sampleRate,
  bitrate: output.bitrate,
  forceTranscode: true,
});

const selectVideoTrack = async (
  input: Input,
  trackId: string | undefined,
): Promise<InputVideoTrack | null | undefined> =>
  trackId === undefined
    ? input.getPrimaryVideoTrack()
    : (await input.getVideoTracks()).find((track) => String(track.id) === trackId);

const selectAudioTrack = async (
  input: Input,
  trackId: string | undefined,
): Promise<InputAudioTrack | null | undefined> =>
  trackId === undefined
    ? input.getPrimaryAudioTrack()
    : (await input.getAudioTracks()).find((track) => String(track.id) === trackId);

const prepareVideoTrack = async (track: InputVideoTrack, startSeconds: number) => {
  const sink = new EncodedPacketSink(track);
  const [codec, decoderConfig, rotation, languageCode, disposition, hasOnlyKeyPackets] =
    await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
      track.getRotation(),
      track.getLanguageCode(),
      track.getDisposition(),
      track.hasOnlyKeyPackets(),
    ]);
  if (!codec) throw new MediabunnyConversionUnsupportedError(['unknown_video_codec']);
  const startPacket =
    (await sink.getKeyPacket(startSeconds, { verifyKeyPackets: true })) ??
    (await sink.getFirstKeyPacket({ verifyKeyPackets: true }));
  if (!startPacket) throw new MediabunnyConversionUnsupportedError(['video_has_no_key_packet']);
  return {
    sink,
    source: new EncodedVideoPacketSource(codec),
    startPacket,
    decoderConfig,
    rotation,
    languageCode,
    disposition,
    hasOnlyKeyPackets,
  };
};

const prepareAudioTrack = async (track: InputAudioTrack, startSeconds: number) => {
  const sink = new EncodedPacketSink(track);
  const [codec, decoderConfig, languageCode, disposition] = await Promise.all([
    track.getCodec(),
    track.getDecoderConfig(),
    track.getLanguageCode(),
    track.getDisposition(),
  ]);
  if (!codec) throw new MediabunnyConversionUnsupportedError(['unknown_audio_codec']);
  let startPacket = (await sink.getPacket(startSeconds)) ?? (await sink.getFirstPacket());
  while (startPacket && startPacket.timestamp < startSeconds) {
    startPacket = await sink.getNextPacket(startPacket);
  }
  if (!startPacket) return undefined;
  return {
    sink,
    source: new EncodedAudioPacketSource(codec),
    startPacket,
    decoderConfig,
    languageCode,
    disposition,
  };
};

/** MediaBunny 1.x 的 MP4 输出只接受三字母 ISO 639-2/T；其他语言标记交由播放器按未知处理。 */
const normalizeOutputLanguageCode = (languageCode: string | undefined): string | undefined =>
  languageCode && /^[a-z]{3}$/.test(languageCode) ? languageCode : undefined;

const pumpPackets = async (
  trackId: FragmentTrackId,
  packets: AsyncIterable<import('mediabunny').EncodedPacket>,
  source: EncodedVideoPacketSource | EncodedAudioPacketSource,
  timelineOffsetSeconds: number,
  signal: AbortSignal,
  trackBarrier: TrackTimestampBarrier,
): Promise<void> => {
  try {
    for await (const packet of packets) {
      if (signal.aborted) throw signal.reason;
      const shifted = packet.clone({ timestamp: packet.timestamp - timelineOffsetSeconds });
      if (source instanceof EncodedVideoPacketSource) await source.add(shifted);
      else await source.add(shifted);
      await trackBarrier.advance(trackId, shifted.timestamp);
    }
  } finally {
    source.close();
    trackBarrier.closeTrack(trackId);
  }
};

type FragmentTrackId = 'audio' | 'video';

interface TrackBarrierWaiter {
  readonly timestamp: number;
  resolve(): void;
  reject(reason: unknown): void;
}

/** 限制快轨领先慢轨的媒体时间，避免 MP4 复用器在弱网下积存无界编码包。 */
class TrackTimestampBarrier {
  private readonly positions = new Map<FragmentTrackId, number>();
  private readonly waiters = new Set<TrackBarrierWaiter>();
  private abortedReason: unknown;

  constructor(
    private readonly signal: AbortSignal,
    private readonly maxLeadSeconds = MAX_TRACK_LEAD_SECONDS,
  ) {
    if (signal.aborted) this.abort(signal.reason);
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  register(trackId: FragmentTrackId): void {
    this.positions.set(trackId, 0);
  }

  async advance(trackId: FragmentTrackId, timestamp: number): Promise<void> {
    if (this.signal.aborted) throw this.signal.reason;
    if (this.abortedReason !== undefined) throw this.abortedReason;
    const current = this.positions.get(trackId);
    if (current === undefined) return;
    const position = this.observe(trackId, timestamp);
    if (!this.mustWait(position)) return;

    await new Promise<void>((resolve, reject) => {
      const waiter = { timestamp: position, resolve, reject };
      this.waiters.add(waiter);
      if (!this.mustWait(position)) {
        this.waiters.delete(waiter);
        resolve();
      }
    });
  }

  /** 更新不需要等待的轨道进度，用于接收第三方转换器的同步进度回调。 */
  observe(trackId: FragmentTrackId, timestamp: number): number {
    const current = this.positions.get(trackId);
    if (current === undefined) return timestamp;
    const position = Math.max(current, timestamp);
    this.positions.set(trackId, position);
    this.releaseReadyWaiters();
    return position;
  }

  closeTrack(trackId: FragmentTrackId): void {
    this.positions.delete(trackId);
    this.releaseReadyWaiters();
  }

  dispose(): void {
    this.signal.removeEventListener('abort', this.onAbort);
    this.releaseAllWaiters();
  }

  private readonly onAbort = (): void => this.abort(this.signal.reason);

  private abort(reason: unknown): void {
    if (this.abortedReason !== undefined) return;
    this.abortedReason = reason ?? new MediabunnyFragmentStreamCancelledError();
    for (const waiter of this.waiters) waiter.reject(this.abortedReason);
    this.waiters.clear();
  }

  private mustWait(timestamp: number): boolean {
    if (this.positions.size <= 1) return false;
    return timestamp - Math.min(...this.positions.values()) > this.maxLeadSeconds;
  }

  private releaseReadyWaiters(): void {
    for (const waiter of this.waiters) {
      if (this.mustWait(waiter.timestamp)) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  private releaseAllWaiters(): void {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }
}

const validateOptions = (options: MediaFragmentStreamOptions): void => {
  if (
    options.minimumFragmentDuration !== undefined &&
    (!Number.isFinite(options.minimumFragmentDuration) || options.minimumFragmentDuration <= 0)
  ) {
    throw new RangeError('minimumFragmentDuration must be greater than zero');
  }
  if (
    options.startSeconds !== undefined &&
    (!Number.isFinite(options.startSeconds) || options.startSeconds < 0)
  ) {
    throw new RangeError('startSeconds must not be negative');
  }
  if (options.outputAudio) validateAudioOutput(options.outputAudio);
};

const validateAudioOutput = (output: AudioTranscodeOutput): void => {
  if (output.codec !== 'aac' || output.codecString.trim() === '') {
    throw new TypeError('outputAudio must describe AAC with a codec string');
  }
  if (!Number.isInteger(output.channels) || output.channels <= 0) {
    throw new RangeError('outputAudio.channels must be greater than zero');
  }
  if (!Number.isInteger(output.sampleRate) || output.sampleRate <= 0) {
    throw new RangeError('outputAudio.sampleRate must be greater than zero');
  }
  if (!Number.isInteger(output.bitrate) || output.bitrate <= 0) {
    throw new RangeError('outputAudio.bitrate must be greater than zero');
  }
};

export class MediabunnyConversionUnsupportedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super('Media tracks cannot be converted to fragmented MP4');
    this.name = 'MediabunnyConversionUnsupportedError';
  }
}

export class MediabunnySeekOutOfRangeError extends RangeError {
  constructor(
    readonly requestedSeconds: number,
    readonly durationSeconds: number,
  ) {
    super('Seek position is outside the media duration');
    this.name = 'MediabunnySeekOutOfRangeError';
  }
}

class MediabunnyFragmentStreamCancelledError extends Error {
  constructor() {
    super('Media fragment stream was cancelled');
    this.name = 'MediabunnyFragmentStreamCancelledError';
  }
}
