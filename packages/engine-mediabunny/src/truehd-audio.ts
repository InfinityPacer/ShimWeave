import type { TrueHdDecoder } from '@shimweave/codec-truehd';
import type { AudioTranscodeOutput } from '@shimweave/contracts';
import {
  AudioSample,
  AudioSampleSource,
  EncodedPacketSink,
  type InputAudioTrack,
} from 'mediabunny';

/**
 * Mediabunny 不认识 TrueHD：轨道的 codec 为 null，自身的解码与 Conversion 都会丢弃它。
 * 这里按 Matroska CodecID 识别，改由 @shimweave/codec-truehd 解码，再交给 Mediabunny 编码为 AAC。
 */
export const isTrueHdTrack = async (track: InputAudioTrack): Promise<boolean> => {
  if ((await track.getCodec()) !== null) return false;
  const internal = await track.getInternalCodecId();
  return typeof internal === 'string' && internal.toUpperCase() === 'A_TRUEHD';
};

export interface PreparedTrueHdAudio {
  readonly source: AudioSampleSource;
  readonly languageCode: string;
  readonly disposition: Awaited<ReturnType<InputAudioTrack['getDisposition']>>;
  pump(
    timelineOffsetSeconds: number,
    signal: AbortSignal,
    advance: (timestamp: number) => Promise<void>,
  ): Promise<void>;
  close(): void;
}

/**
 * 从 startSeconds 之前最近的 major sync 开始解码。MKV 的包时间戳按毫秒取整，
 * 所以只用第一段保留音频的包时间戳定锚，之后按解码出的采样帧数推进，保证输出连续。
 */
export const prepareTrueHdAudio = async (
  track: InputAudioTrack,
  startSeconds: number,
  outputAudio: AudioTranscodeOutput,
): Promise<PreparedTrueHdAudio | undefined> => {
  const sink = new EncodedPacketSink(track);
  // 其他封装器可能不给 TrueHD 块打关键帧标记，这时从普通包开始，解码器会自行等到 major sync。
  const startPacket =
    (await sink.getKeyPacket(startSeconds)) ??
    (await sink.getPacket(startSeconds)) ??
    (await sink.getFirstPacket());
  if (!startPacket) return undefined;
  const [languageCode, disposition, { createTrueHdDecoder }] = await Promise.all([
    track.getLanguageCode(),
    track.getDisposition(),
    import('@shimweave/codec-truehd'),
  ]);
  const decoder: TrueHdDecoder = await createTrueHdDecoder({
    channels: outputAudio.channels >= 6 ? 6 : 2,
  });
  const source = new AudioSampleSource({
    codec: 'aac',
    bitrate: outputAudio.bitrate,
    // 流内没有对应声道数的呈现子流、或采样率不是 48 kHz 时，由编码前的变换统一到计划的输出配置。
    transform: { numberOfChannels: outputAudio.channels, sampleRate: outputAudio.sampleRate },
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    decoder.close();
  };

  return {
    source,
    languageCode,
    disposition,
    close,
    pump: async (timelineOffsetSeconds, signal, advance) => {
      let cursor: number | undefined;
      try {
        for await (const packet of sink.packets(startPacket)) {
          if (signal.aborted) throw signal.reason;
          for (const audio of decoder.decode(packet.data)) {
            if (cursor === undefined) {
              // 视频关键帧之前的音频不输出，避免负时间戳；一个访问单元只有 1/1200 秒左右。
              if (packet.timestamp < timelineOffsetSeconds) continue;
              cursor = packet.timestamp - timelineOffsetSeconds;
            }
            const sample = new AudioSample({
              data: concatPlanes(audio.planes, audio.numberOfFrames),
              format: 'f32-planar',
              numberOfChannels: audio.numberOfChannels,
              sampleRate: audio.sampleRate,
              timestamp: cursor,
            });
            try {
              await source.add(sample);
            } finally {
              sample.close();
            }
            cursor += audio.numberOfFrames / audio.sampleRate;
            await advance(cursor);
          }
        }
      } finally {
        source.close();
        close();
      }
    },
  };
};

const concatPlanes = (planes: readonly Float32Array[], frames: number): Float32Array => {
  const data = new Float32Array(planes.length * frames);
  planes.forEach((plane, index) => {
    data.set(plane.subarray(0, frames), index * frames);
  });
  return data;
};
