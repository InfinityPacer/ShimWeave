import type { ByteRange, ByteSource } from '@shimweave/contracts';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { MediabunnyMediaSession } from './media-session.js';

/**
 * 夹具由 ffmpeg 合成：64x36、24 fps、3 秒，每秒一个开放 GOP 随机访问点，3 个 B 帧，另有单声道 AAC。
 * - open-gop-hevc.mkv：x265 `open-gop=1:keyint=24:min-keyint=24:scenecut=0:bframes=3`，1 秒和 2 秒处
 *   是 CRA，解码顺序上紧跟呈现更早的 RASL；
 * - open-gop-avc.mp4：x264 同样参数加 `b-pyramid=normal`，随机访问点是带恢复点 SEI 的非 IDR I 帧；
 * - crossing-gop-hevc.mkv：由 open-gop-hevc.mkv 经 `setts` 交换第 17 包（上一 GOP 的尾随 P，0.833 秒）
 *   与第 23 包（1 秒 CRA 的 RASL，0.875 秒）的呈现时间，得到前导图像早于上一 GOP 已有图像的排列；
 * - late-key-hevc.mkv：同样由 open-gop-hevc.mkv 交换第 17 包（0.833 秒）与第 21 包（1 秒 CRA）的
 *   呈现时间，关键帧本身早于上一 GOP 已有的 1 秒图像，对应分段编码拼接处的 IDR。
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

class MemoryByteSource implements ByteSource {
  readonly sourceId = 'fixture:open-gop';

  constructor(private readonly bytes: Uint8Array) {}

  async getSize(): Promise<number> {
    return this.bytes.length;
  }

  async read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    return this.bytes.slice(range.start, range.end);
  }

  close(): void {}
}

/** 包内 tsconfig 不带 Node 类型，测试运行时按字符串动态加载文件系统模块。 */
const readFixture = async (name: string): Promise<Uint8Array> => {
  const specifier: string = 'node:fs/promises';
  const fs = (await import(/* @vite-ignore */ specifier)) as {
    readFile(path: URL): Promise<Uint8Array>;
  };
  return new Uint8Array(await fs.readFile(fixture(name)));
};

/** 毫秒取整后的视频包呈现时间，按呈现顺序排列。 */
const videoTimestamps = async (bytes: Uint8Array, offsetSeconds = 0): Promise<number[]> => {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('fixture has no video track');
  const timestamps: number[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    timestamps.push(Math.round((packet.timestamp + offsetSeconds) * 1000));
  }
  input.dispose();
  return timestamps.sort((left, right) => left - right);
};

const remux = async (name: string, startSeconds?: number) => {
  const source = await readFixture(name);
  const session = new MediabunnyMediaSession(new MemoryByteSource(source));
  const chunks: Uint8Array[] = [];
  const stream = await session.startFragmentStream(
    { write: async (bytes) => void chunks.push(bytes.slice()) },
    startSeconds === undefined ? {} : { startSeconds },
  );
  await stream.completion;
  await session.close();
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return {
    source: await videoTimestamps(source),
    output: await videoTimestamps(output, stream.timelineOffsetSeconds),
    timelineOffsetSeconds: stream.timelineOffsetSeconds,
    initialPositionSeconds: stream.initialPositionSeconds,
  };
};

describe('开放 GOP 片源转封装（合成夹具）', () => {
  for (const name of ['open-gop-hevc.mkv', 'open-gop-avc.mp4']) {
    it(`${name} 从头播放保留全部视频帧`, async () => {
      const result = await remux(name);

      expect(result.timelineOffsetSeconds).toBe(0);
      expect(result.output).toEqual(result.source);
    });

    it(`${name} 从开放 GOP 关键帧 Seek 时丢弃无法解码的前导图像`, async () => {
      const result = await remux(name, 1.5);

      expect(result.timelineOffsetSeconds).toBeCloseTo(1, 3);
      expect(result.initialPositionSeconds).toBeCloseTo(0.5, 3);
      expect(result.output).toEqual(result.source.filter((timestamp) => timestamp >= 1000));
    });
  }

  it('前导图像早于上一 GOP 时只丢弃该关键帧的前导图像，其余帧继续输出', async () => {
    const result = await remux('crossing-gop-hevc.mkv');

    // 1 秒 CRA 的三张 RASL（0.917、0.834、0.958 秒）早于或穿插上一 GOP 已写出的 0.875 秒。
    expect(result.source.filter((timestamp) => !result.output.includes(timestamp))).toEqual([
      834, 917, 958,
    ]);
    expect(result.output).toHaveLength(result.source.length - 3);
  });

  it('关键帧早于上一 GOP 已有图像时保留全部帧继续输出', async () => {
    const result = await remux('late-key-hevc.mkv');

    expect(result.output).toEqual(result.source);
  });
});
