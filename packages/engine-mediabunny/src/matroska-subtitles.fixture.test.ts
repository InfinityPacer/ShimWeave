import type {
  ByteRange,
  ByteSource,
  SubtitleCue,
  SubtitleUnavailableReason,
} from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { MediabunnyMediaSession } from './media-session.js';

/**
 * 夹具由 ffmpeg 合成：10 秒 64x36 灰屏 H.264、单声道 AAC 正弦波，外加同一份 SRT 生成的
 * S_TEXT/UTF8（轨道 3，中文）与 S_TEXT/ASS（轨道 4，英文）两条字幕，簇长约 1 秒。
 */
const FIXTURE = new URL('./fixtures/srt-subtitles.mkv', import.meta.url);

class MemoryByteSource implements ByteSource {
  readonly sourceId = 'fixture:srt-subtitles';
  readonly reads: ByteRange[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  async getSize(): Promise<number> {
    return this.bytes.length;
  }

  async read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.reads.push(range);
    return this.bytes.slice(range.start, range.end);
  }

  close(): void {}
}

/** 包内 tsconfig 不带 Node 类型，测试运行时按字符串动态加载文件系统模块。 */
const readFixture = async (): Promise<Uint8Array> => {
  const specifier: string = 'node:fs/promises';
  const fs = (await import(/* @vite-ignore */ specifier)) as {
    readFile(path: URL): Promise<Uint8Array>;
  };
  return new Uint8Array(await fs.readFile(FIXTURE));
};

const openFixture = async () => {
  const source = new MemoryByteSource(await readFixture());
  return { source, session: new MediabunnyMediaSession(source) };
};

const collectSink = () => {
  const cues: SubtitleCue[] = [];
  const failures: SubtitleUnavailableReason[] = [];
  return {
    cues,
    failures,
    sink: {
      cues: (batch: readonly SubtitleCue[]) => cues.push(...batch),
      fail: (reason: SubtitleUnavailableReason) => failures.push(reason),
    },
  };
};

/** 消费整条分片流，等同 MSE 追加完成后立即确认。 */
const drainingSink = { write: async () => undefined };

describe('Matroska 内嵌字幕（合成夹具）', () => {
  it('描述结果按容器顺序列出字幕轨', async () => {
    const { session } = await openFixture();
    const descriptor = await session.describe();
    const subtitles = descriptor.tracks.filter((track) => track.kind === 'subtitle');

    expect(subtitles).toEqual([
      expect.objectContaining({ id: '3', codec: 'srt', language: 'chi' }),
      expect.objectContaining({ id: '4', codec: 'ass', language: 'eng' }),
    ]);
    await session.close();
  });

  it('跟随 Seek 后的视频流读取字幕，时间为原媒体绝对时间', async () => {
    const { session } = await openFixture();
    const descriptor = await session.describe();
    const video = descriptor.tracks.find((track) => track.kind === 'video');
    const collected = collectSink();

    const subtitles = session.startSubtitleStream(collected.sink, {
      trackId: '3',
      startSeconds: 4.5,
      ...(video ? { videoTrackId: video.id } : {}),
    });
    const stream = await session.startFragmentStream(drainingSink, {
      startSeconds: 4.5,
      ...(video ? { videoTrackId: video.id } : {}),
    });
    await stream.completion;
    await Promise.race([subtitles.completion, new Promise((resolve) => setTimeout(resolve, 200))]);
    await subtitles.cancel();

    expect(collected.failures).toEqual([]);
    expect(collected.cues).toEqual([
      { startSeconds: 5, endSeconds: 7.5, text: '顶部字幕', placement: 'top' },
      { startSeconds: 8, endSeconds: 9.5, text: '最后一句' },
    ]);
    await session.close();
  });

  it('从头播放时读出全部 cue 并保留斜体与换行', async () => {
    const { session } = await openFixture();
    const collected = collectSink();
    const subtitles = session.startSubtitleStream(collected.sink, { trackId: '3' });
    const stream = await session.startFragmentStream(drainingSink, {});
    await stream.completion;
    await Promise.race([subtitles.completion, new Promise((resolve) => setTimeout(resolve, 200))]);
    await subtitles.cancel();

    expect(collected.failures).toEqual([]);
    expect(collected.cues.map((cue) => [cue.startSeconds, cue.endSeconds, cue.text])).toEqual([
      [0.5, 2, '第一句字幕'],
      [2.5, 4, '<i>斜体</i> &amp; 两行\n第二行'],
      [5, 7.5, '顶部字幕'],
      [8, 9.5, '最后一句'],
    ]);
    await session.close();
  });

  it('ASS 字幕明确报告不支持，不影响视频流', async () => {
    const { session } = await openFixture();
    const collected = collectSink();
    const subtitles = session.startSubtitleStream(collected.sink, { trackId: '4' });
    const stream = await session.startFragmentStream(drainingSink, { startSeconds: 1 });
    await Promise.all([stream.completion, subtitles.completion]);

    expect(collected.failures).toEqual(['unsupported_codec']);
    expect(collected.cues).toEqual([]);
    await session.close();
  });

  it('取消字幕流后不再交付 cue', async () => {
    const { session } = await openFixture();
    const collected = collectSink();
    const subtitles = session.startSubtitleStream(collected.sink, { trackId: '3' });
    await subtitles.cancel();
    const stream = await session.startFragmentStream(drainingSink, {});
    await stream.completion;

    expect(collected.cues).toEqual([]);
    expect(collected.failures).toEqual([]);
    await session.close();
  });
});
