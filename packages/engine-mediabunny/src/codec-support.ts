import type { AudioTranscodeOutput } from '@shimweave/contracts';
import { canEncodeAudio } from 'mediabunny';

const installed = new Set<string>();

/** 仅为当前播放计划按需加载编解码扩展，避免扩大普通转封装会话的启动成本。 */
export const ensureAudioCodecSupport = async (
  inputCodec: string | undefined,
  outputAudio: AudioTranscodeOutput,
): Promise<void> => {
  if ((inputCodec === 'ac3' || inputCodec === 'eac3') && !installed.has('ac3-decoder')) {
    const { registerAc3Decoder } = await import('@mediabunny/ac3');
    registerAc3Decoder();
    installed.add('ac3-decoder');
  }

  if (inputCodec === 'dts' && !installed.has('dts-decoder')) {
    const { registerDtsDecoder } = await import('@mediabunny/dts');
    registerDtsDecoder();
    installed.add('dts-decoder');
  }

  if (
    outputAudio.codec === 'aac' &&
    !installed.has('aac-encoder') &&
    !(await canEncodeAudio('aac', {
      numberOfChannels: outputAudio.channels,
      sampleRate: outputAudio.sampleRate,
      bitrate: outputAudio.bitrate,
    }))
  ) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    installed.add('aac-encoder');
  }
};
