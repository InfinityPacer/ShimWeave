import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { ALL_FORMATS, BufferSource, FilePathSource, Input } from 'mediabunny';
import { beforeAll, describe, expect, it } from 'vitest';
import { startMediaFragmentStream } from './fragment-stream.js';
import { isTrueHdTrack } from './truehd-audio.js';

// 0.5 秒合成 5.1 正弦 TrueHD，来自 @shimweave/codec-truehd 的测试夹具，不含真实媒体。
const fixture = new URL('../../codec-truehd/src/fixtures/sine-5.1.mkv', import.meta.url);

const outputAudio = {
  codec: 'aac' as const,
  codecString: 'mp4a.40.2',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
  bitrate: 192_000,
};

const openFixture = async () =>
  new Input({ source: new FilePathSource(fixture.pathname), formats: ALL_FORMATS });

const collect = async (startSeconds?: number) => {
  const input = await openFixture();
  const chunks: Uint8Array[] = [];
  const stream = await startMediaFragmentStream(
    input,
    { write: async (bytes) => void chunks.push(bytes.slice()) },
    { outputAudio, ...(startSeconds !== undefined ? { startSeconds } : {}) },
  );
  await stream.completion;
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { stream, output: new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }) };
};

describe('TrueHD 音轨', () => {
  beforeAll(() => {
    registerAacEncoder();
  });

  it('按 Matroska CodecID 识别 Mediabunny 不认识的 TrueHD 轨道', async () => {
    const input = await openFixture();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('fixture has no audio track');
    expect(await track.getCodec()).toBeNull();
    expect(await isTrueHdTrack(track)).toBe(true);
  });

  it('从头播放时解码为计划的立体声 AAC 并保持时长', async () => {
    const { stream, output } = await collect();
    const audio = await output.getPrimaryAudioTrack();

    expect(stream.mimeType).toContain('mp4a');
    expect(await audio?.getCodec()).toBe('aac');
    expect(await audio?.getNumberOfChannels()).toBe(2);
    expect(await audio?.getSampleRate()).toBe(48_000);
    expect(await output.computeDuration()).toBeGreaterThan(0.45);
    expect(await output.computeDuration()).toBeLessThan(0.6);
  });

  it('Seek 后从目标位置之后开始输出，时间轴从零起', async () => {
    const { stream, output } = await collect(0.25);
    const audio = await output.getPrimaryAudioTrack();
    if (!audio) throw new Error('missing audio');

    expect(stream.timelineOffsetSeconds).toBeGreaterThan(0.2);
    expect(await audio.getFirstTimestamp()).toBeGreaterThanOrEqual(0);
    expect(await output.computeDuration()).toBeLessThan(0.35);
  });
});
