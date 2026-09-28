import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { createTrueHdDecoder, type DecodedAudio } from './index.js';

// 与 scripts/build-fixture.sh 一致：5.1(side) 各声道的正弦频率（Hz），幅度 0.25，时长 0.5 秒。
const CHANNEL_TONES = [500, 700, 1000, 60, 1300, 1700] as const;
const AMPLITUDE = 0.25;
const SAMPLE_RATE = 48_000;
const FIXTURE_FRAMES = 24_000;

const readFixturePackets = async (): Promise<Uint8Array[]> => {
  const input = new Input({
    source: new FilePathSource(new URL('./fixtures/sine-5.1.mkv', import.meta.url).pathname),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('fixture has no audio track');
    const packets: Uint8Array[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet.data);
    return packets;
  } finally {
    input.dispose();
  }
};

const concatPlanes = (decoded: readonly DecodedAudio[]): Float32Array[] => {
  const first = decoded[0];
  if (!first) return [];
  const total = decoded.reduce((sum, audio) => sum + audio.numberOfFrames, 0);
  return Array.from({ length: first.numberOfChannels }, (_, channel) => {
    const plane = new Float32Array(total);
    let offset = 0;
    for (const audio of decoded) {
      plane.set(audio.planes[channel] ?? [], offset);
      offset += audio.numberOfFrames;
    }
    return plane;
  });
};

// Goertzel 单频能量，归一化为该频率正弦分量的幅度。
const toneAmplitude = (samples: Float32Array, frequency: number): number => {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  const power = previous ** 2 + beforePrevious ** 2 - coefficient * previous * beforePrevious;
  return (2 * Math.sqrt(Math.max(power, 0))) / samples.length;
};

const decodeAll = async (channels: 2 | 6 | 8, packets: readonly Uint8Array[]) => {
  const decoder = await createTrueHdDecoder({ channels });
  try {
    const decoded = packets.flatMap((packet) => decoder.decode(packet));
    return { decoded, corruptUnits: decoder.corruptUnits };
  } finally {
    decoder.close();
  }
};

describe('createTrueHdDecoder', () => {
  it('5.1 输出与合成信号逐样本一致，声道顺序为 FFmpeg 原生顺序', async () => {
    const packets = await readFixturePackets();
    const { decoded, corruptUnits } = await decodeAll(6, packets);

    expect(corruptUnits).toBe(0);
    expect(decoded.every((audio) => audio.sampleRate === SAMPLE_RATE)).toBe(true);
    expect(decoded.every((audio) => audio.numberOfChannels === 6)).toBe(true);
    expect(decoded[0]?.channelLayout).toBe('5.1(side)');
    const planes = concatPlanes(decoded);
    expect(planes).toHaveLength(6);

    CHANNEL_TONES.forEach((frequency, channel) => {
      const plane = planes[channel] ?? new Float32Array();
      expect(plane.length).toBe(FIXTURE_FRAMES);
      let maxError = 0;
      for (let index = 0; index < plane.length; index += 1) {
        const expected = AMPLITUDE * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
        maxError = Math.max(maxError, Math.abs((plane[index] ?? 0) - expected));
      }
      // TrueHD 无损，误差只来自 24 位量化。
      expect(maxError).toBeLessThan(1e-6);
    });
  });

  it('默认取双声道呈现子流而不是自行混音', async () => {
    const packets = await readFixturePackets();
    const { decoded, corruptUnits } = await decodeAll(2, packets);

    expect(corruptUnits).toBe(0);
    expect(decoded.every((audio) => audio.numberOfChannels === 2)).toBe(true);
    expect(decoded[0]?.channelLayout).toBe('stereo');
    const [left = new Float32Array(), right = new Float32Array()] = concatPlanes(decoded);
    expect(left.length).toBe(FIXTURE_FRAMES);
    expect(right.length).toBe(FIXTURE_FRAMES);

    // FFmpeg 的 TrueHD 编码器把双声道呈现写成 FL/FR 原样（Dolby 编码器会写入矩阵下混），
    // 所以这里验证的是解码器取出了呈现子流：左右声道只含各自前置声道的正弦，中置等声道没有被混入。
    expect(toneAmplitude(left, 500)).toBeCloseTo(AMPLITUDE, 3);
    expect(toneAmplitude(right, 700)).toBeCloseTo(AMPLITUDE, 3);
    for (const frequency of [700, 1000, 60, 1300, 1700]) {
      expect(toneAmplitude(left, frequency)).toBeLessThan(1e-3);
    }
    for (const frequency of [500, 1000, 60, 1300, 1700]) {
      expect(toneAmplitude(right, frequency)).toBeLessThan(1e-3);
    }
  });

  it('接受含多个访问单元的 Block 负载，结果与逐单元送入一致', async () => {
    const packets = await readFixturePackets();
    const grouped: Uint8Array[] = [];
    for (let index = 0; index < packets.length; index += 5) {
      const group = packets.slice(index, index + 5);
      const merged = new Uint8Array(group.reduce((sum, packet) => sum + packet.byteLength, 0));
      let offset = 0;
      for (const packet of group) {
        merged.set(packet, offset);
        offset += packet.byteLength;
      }
      grouped.push(merged);
    }

    const single = concatPlanes((await decodeAll(6, packets)).decoded);
    const { decoded } = await decodeAll(6, grouped);
    // 同一包内的访问单元合并成一段输出。
    expect(decoded).toHaveLength(grouped.length);
    expect(concatPlanes(decoded)).toEqual(single);
  });

  it('flush 后从非 major sync 单元开始不输出，直到下一个 major sync', async () => {
    const packets = await readFixturePackets();
    const decoder = await createTrueHdDecoder({ channels: 6 });
    try {
      decoder.decode(packets[0] ?? new Uint8Array());
      decoder.flush();
      expect(decoder.decode(packets[1] ?? new Uint8Array())).toEqual([]);
      // 夹具每 16 个访问单元一个 major sync。
      const resumed = packets.slice(2, 17).flatMap((packet) => decoder.decode(packet));
      expect(resumed.reduce((sum, audio) => sum + audio.numberOfFrames, 0)).toBe(40);
      expect(decoder.corruptUnits).toBe(0);
    } finally {
      decoder.close();
    }
  });

  it('跳过损坏的访问单元并在下一个 major sync 恢复', async () => {
    const packets = await readFixturePackets();
    const decoder = await createTrueHdDecoder({ channels: 6 });
    try {
      const damaged = packets.map((packet, index) => {
        if (index !== 20) return packet;
        const copy = packet.slice();
        copy.fill(0x5a, 4);
        return copy;
      });
      const decoded = damaged.flatMap((packet) => decoder.decode(packet));
      const frames = decoded.reduce((sum, audio) => sum + audio.numberOfFrames, 0);
      expect(decoder.corruptUnits).toBeGreaterThan(0);
      expect(frames).toBeGreaterThan(FIXTURE_FRAMES / 2);
      expect(frames).toBeLessThan(FIXTURE_FRAMES);
    } finally {
      decoder.close();
    }
  });

  it('关闭后拒绝继续解码，非法声道数直接拒绝', async () => {
    const decoder = await createTrueHdDecoder();
    decoder.close();
    decoder.close();
    expect(() => decoder.decode(new Uint8Array([1, 2, 3, 4]))).toThrow('closed');
    await expect(createTrueHdDecoder({ channels: 4 as 2 })).rejects.toThrow(RangeError);
  });
});
