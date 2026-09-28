import type { SubtitleCue } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { ByteCoverage } from './byte-coverage.js';
import {
  extractMatroskaSubtitles,
  type MatroskaContentEncoding,
  MatroskaSubtitleUnavailableError,
  parseMatroskaBlock,
  readMatroskaCuePoints,
  readMatroskaSubtitleLayout,
} from './matroska-subtitles.js';

const ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  name: 0x536e,
  language: 0x22b59c,
  flagDefault: 0x88,
  flagForced: 0x55aa,
  contentEncodings: 0x6d80,
  contentEncoding: 0x6240,
  contentEncodingType: 0x5033,
  contentCompression: 0x5034,
  contentCompAlgo: 0x4254,
  contentCompSettings: 0x4255,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
} as const;

const VIDEO = 1;
const SUBTITLE = 2;

describe('parseMatroskaBlock', () => {
  it('读取轨道号、有符号相对时间和无 lacing 负载', () => {
    const parsed = parseMatroskaBlock(blockPayload(SUBTITLE, -2, text('你好')));
    expect(parsed?.track).toBe(SUBTITLE);
    expect(parsed?.relativeTimestamp).toBe(-2);
    expect(parsed?.frames.map(decode)).toEqual(['你好']);
  });

  it('按 Xiph、固定长度与 EBML lacing 拆分帧', () => {
    const xiph = concat(
      Uint8Array.of(0x80 | SUBTITLE, 0, 0, 0x02, 2, 3, 2),
      text('abc'),
      text('xy'),
      text('!'),
    );
    expect(parseMatroskaBlock(xiph)?.frames.map(decode)).toEqual(['abc', 'xy', '!']);

    const fixed = concat(Uint8Array.of(0x80 | SUBTITLE, 0, 0, 0x04, 1), text('abcd'));
    expect(parseMatroskaBlock(fixed)?.frames.map(decode)).toEqual(['ab', 'cd']);

    // 第一帧 3 字节，第二帧差值 -1（有符号 vint 0xBE），第三帧取剩余。
    const ebml = concat(
      Uint8Array.of(0x80 | SUBTITLE, 0, 0, 0x06, 2, 0x83, 0xbe),
      text('abc'),
      text('de'),
      text('f'),
    );
    expect(parseMatroskaBlock(ebml)?.frames.map(decode)).toEqual(['abc', 'de', 'f']);
  });

  it('长度不自洽的 lacing 块返回 undefined', () => {
    expect(parseMatroskaBlock(Uint8Array.of(0x80 | SUBTITLE, 0, 0, 0x02, 1, 9, 0x41))).toBe(
      undefined,
    );
    expect(parseMatroskaBlock(Uint8Array.of(0x80 | SUBTITLE, 0, 0, 0x04, 1, 0x41))).toBe(undefined);
    expect(parseMatroskaBlock(Uint8Array.of(0x80 | SUBTITLE, 0))).toBeUndefined();
  });
});

describe('readMatroskaSubtitleLayout', () => {
  it('读取字幕 TrackEntry、时间刻度、Cues 与首个簇位置', async () => {
    const file = buildFile();
    const layout = await readMatroskaSubtitleLayout(readerFor(file.bytes), file.bytes.length);

    expect(layout).toMatchObject({
      segmentDataStart: file.segmentDataStart,
      timestampScale: 1_000_000,
      cuesPosition: file.cuesPosition,
      firstClusterPosition: file.clusterPositions[0],
      subtitleTracks: [
        {
          trackNumber: SUBTITLE,
          codecId: 'S_TEXT/UTF8',
          codec: 'srt',
          language: 'chi',
          name: '简体',
          isDefault: false,
          isForced: true,
          encoding: { kind: 'none' },
        },
      ],
    });
    await expect(
      readMatroskaCuePoints(readerFor(file.bytes), requireValue(layout)),
    ).resolves.toEqual([
      { timeTicks: 0, track: VIDEO, clusterPosition: file.clusterPositions[0] },
      { timeTicks: 2_000, track: VIDEO, clusterPosition: file.clusterPositions[1] },
    ]);
  });

  it('识别 zlib、头部剥离与加密编码', async () => {
    const encodings: [Uint8Array, MatroskaContentEncoding][] = [
      [compression(0), { kind: 'zlib' }],
      [compression(3, text('<')), { kind: 'header-stripping', prefix: text('<') }],
      [
        element(ID.contentEncoding, element(ID.contentEncodingType, unsigned(1))),
        { kind: 'unsupported' },
      ],
    ];
    for (const [encoding, expected] of encodings) {
      const file = buildFile({ encoding });
      const layout = await readMatroskaSubtitleLayout(readerFor(file.bytes), file.bytes.length);
      expect(layout?.subtitleTracks[0]?.encoding).toEqual(expected);
    }
  });
});

describe('extractMatroskaSubtitles', () => {
  it('从已覆盖的簇里取出字幕块，忽略其他轨道与多帧 lacing', async () => {
    const file = buildFile();
    const run = await extraction(file);
    run.coverage.add(0, file.bytes.length);

    await run.completion;

    expect(run.cues).toEqual([
      { startSeconds: 0.5, endSeconds: 2, text: '第一句' },
      { startSeconds: 2.1, endSeconds: 2.9, text: '<i>第二句</i>', placement: 'top' },
      { startSeconds: 3, endSeconds: 8, text: '没有时长' },
    ]);
  });

  it('只在视频流读过对应簇之后才读取，不越过覆盖范围', async () => {
    const file = buildFile();
    const run = await extraction(file);
    await flush();
    expect(run.reads).toEqual([]);

    run.coverage.add(at(file.clusterPositions, 0), at(file.clusterPositions, 1));
    await flush();
    expect(run.cues.map((cue) => cue.text)).toEqual(['第一句']);
    expect(run.reads.every(([, end]) => end <= at(file.clusterPositions, 1) + 12)).toBe(true);

    // 簇之后的元素也被读过时字幕流才能确认结束；否则由宿主在视频流结束后取消。
    run.coverage.add(at(file.clusterPositions, 1), file.bytes.length);
    await run.completion;
    expect(run.cues.map((cue) => cue.text)).toEqual(['第一句', '<i>第二句</i>', '没有时长']);
  });

  it('Seek 后从不晚于目标时间的视频索引簇开始', async () => {
    const file = buildFile();
    const run = await extraction(file, { startSeconds: 2.5 });
    run.coverage.add(at(file.clusterPositions, 1), file.bytes.length);

    await run.completion;

    expect(run.cues.map((cue) => cue.startSeconds)).toEqual([2.1, 3]);
  });

  it('视频流跳过当前簇时按索引重新对齐到已读的簇', async () => {
    const file = buildFile();
    const run = await extraction(file);
    run.coverage.add(at(file.clusterPositions, 1), file.bytes.length);

    await run.completion;

    expect(run.cues.map((cue) => cue.text)).toEqual(['<i>第二句</i>', '没有时长']);
  });

  it('簇头读过而数据没被重读、下一个簇已读时跳过该簇，不停在原地', async () => {
    const file = buildFile();
    const run = await extraction(file);
    // 解封装器复用描述阶段缓存的第一个簇：本代只重读了它的簇头，随后读了第二个簇。
    run.coverage.add(at(file.clusterPositions, 0), at(file.clusterPositions, 0) + 16);
    run.coverage.add(at(file.clusterPositions, 1), file.bytes.length);

    await run.completion;

    expect(run.cues.map((cue) => cue.text)).toEqual(['<i>第二句</i>', '没有时长']);
    expect(
      run.reads.every(
        ([start]) =>
          start >= at(file.clusterPositions, 1) || start === at(file.clusterPositions, 0),
      ),
    ).toBe(true);
  });

  it('解开 zlib 与头部剥离编码的负载', async () => {
    const zlibPayloads = new Map<string, Uint8Array>();
    for (const value of ['第一句', '{\\an8}<i>第二句</i>', '没有时长']) {
      zlibPayloads.set(value, await deflate(text(value)));
    }
    const zlib = buildFile({
      encoding: compression(0),
      transform: (payload) => zlibPayloads.get(decode(payload)) ?? payload,
    });
    const zlibRun = await extraction(zlib);
    zlibRun.coverage.add(0, zlib.bytes.length);
    await zlibRun.completion;
    expect(zlibRun.cues.map((cue) => cue.text)).toEqual(['第一句', '<i>第二句</i>', '没有时长']);

    const prefix = text('第');
    const stripped = buildFile({
      encoding: compression(3, prefix),
      transform: (payload) => payload.subarray(prefix.length),
    });
    const strippedRun = await extraction(stripped);
    strippedRun.coverage.add(0, stripped.bytes.length);
    await strippedRun.completion;
    expect(strippedRun.cues[0]?.text).toBe('第一句');
  });

  it('缺少索引时 Seek 报告 no_index，加密编码报告 unsupported_encoding', async () => {
    const file = buildFile({ cues: false });
    const noIndex = await extraction(file, { startSeconds: 2 });
    await expect(noIndex.completion).rejects.toEqual(
      new MatroskaSubtitleUnavailableError('no_index'),
    );

    const fromStart = await extraction(file);
    fromStart.coverage.add(0, file.bytes.length);
    await fromStart.completion;
    expect(fromStart.cues).toHaveLength(3);

    const encrypted = buildFile({
      encoding: element(ID.contentEncoding, element(ID.contentEncodingType, unsigned(1))),
    });
    await expect((await extraction(encrypted)).completion).rejects.toEqual(
      new MatroskaSubtitleUnavailableError('unsupported_encoding'),
    );
  });

  it('取消后停止等待并以取消原因结束', async () => {
    const file = buildFile();
    const run = await extraction(file);
    const reason = new Error('cancelled');
    run.abort(reason);
    await expect(run.completion).rejects.toBe(reason);
    expect(run.cues).toEqual([]);
  });
});

interface FileOptions {
  encoding?: Uint8Array;
  transform?: (payload: Uint8Array) => Uint8Array;
  cues?: boolean;
}

const buildFile = (options: FileOptions = {}) => {
  const payload = (value: string) => (options.transform ?? ((bytes) => bytes))(text(value));
  const subtitleEntry = element(
    ID.trackEntry,
    concat(
      element(ID.trackNumber, unsigned(SUBTITLE)),
      element(ID.trackType, unsigned(0x11)),
      element(ID.codecId, ascii('S_TEXT/UTF8')),
      element(ID.name, text('简体')),
      element(ID.language, ascii('chi')),
      element(ID.flagDefault, unsigned(0)),
      element(ID.flagForced, unsigned(1)),
      options.encoding ? element(ID.contentEncodings, options.encoding) : new Uint8Array(),
    ),
  );
  const head = concat(
    element(ID.info, element(ID.timestampScale, unsigned(1_000_000))),
    element(
      ID.tracks,
      concat(
        element(
          ID.trackEntry,
          concat(
            element(ID.trackNumber, unsigned(VIDEO)),
            element(ID.trackType, unsigned(1)),
            element(ID.codecId, ascii('V_MPEG4/ISO/AVC')),
          ),
        ),
        subtitleEntry,
      ),
    ),
  );
  const clusters = [
    element(
      ID.cluster,
      concat(
        element(ID.timestamp, unsigned(0)),
        element(ID.simpleBlock, blockPayload(VIDEO, 0, new Uint8Array(64))),
        group(blockPayload(SUBTITLE, 500, payload('第一句')), 1_500),
        // 多帧 lacing 的字幕块语义不明，应被丢弃。
        group(concat(Uint8Array.of(0x80 | SUBTITLE, 0x02, 0x58, 0x04, 1), text('ab')), 500),
      ),
    ),
    element(
      ID.cluster,
      concat(
        element(ID.timestamp, unsigned(2_000)),
        element(ID.simpleBlock, blockPayload(VIDEO, 0, new Uint8Array(64))),
        group(blockPayload(SUBTITLE, 100, payload('{\\an8}<i>第二句</i>')), 800),
        element(ID.simpleBlock, blockPayload(SUBTITLE, 1_000, payload('没有时长'))),
      ),
    ),
  ];
  const segmentHeaderLength = 4 + 4;
  const segmentDataStart = segmentHeaderLength;
  const clusterOffsets = [head.length, head.length + (clusters[0]?.length ?? 0)];
  const cues =
    options.cues === false
      ? new Uint8Array()
      : element(
          ID.cues,
          concat(cuePoint(0, clusterOffsets[0] ?? 0), cuePoint(2_000, clusterOffsets[1] ?? 0)),
        );
  const body = concat(head, ...clusters, cues);
  const segment = concat(idBytes(ID.segment), fixedSize4(body.length), body);
  const clusterPositions = clusterOffsets.map((offset) => segmentDataStart + offset);
  return {
    bytes: segment,
    segmentDataStart,
    clusterPositions,
    cuesPosition: segmentDataStart + head.length + clusters.reduce((sum, c) => sum + c.length, 0),
  };
};

const extraction = async (
  file: ReturnType<typeof buildFile>,
  options: { startSeconds?: number } = {},
) => {
  const reader = readerFor(file.bytes);
  const layout = await readMatroskaSubtitleLayout(reader, file.bytes.length);
  if (!layout) throw new Error('layout missing');
  const cuePoints = await readMatroskaCuePoints(reader, layout);
  const track = layout.subtitleTracks[0];
  if (!track) throw new Error('track missing');
  const coverage = new ByteCoverage();
  const controller = new AbortController();
  const cues: SubtitleCue[] = [];
  const reads: [number, number][] = [];
  const completion = extractMatroskaSubtitles({
    read: async (start, end) => {
      reads.push([start, end]);
      return file.bytes.slice(start, end);
    },
    coverage,
    layout,
    cuePoints,
    track,
    startSeconds: options.startSeconds ?? 0,
    videoTrackNumber: VIDEO,
    sink: { cues: (batch) => cues.push(...batch) },
    signal: controller.signal,
  });
  void completion.catch(() => undefined);
  return {
    coverage,
    cues,
    reads,
    completion,
    abort: (reason: unknown) => controller.abort(reason),
  };
};

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const flush = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const requireValue = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('value missing');
  return value;
};

const at = (values: readonly number[], index: number): number => requireValue(values[index]);

const readerFor = (bytes: Uint8Array) => ({
  read: async (start: number, end: number) => bytes.slice(start, end),
});

const group = (block: Uint8Array, duration: number): Uint8Array =>
  element(
    ID.blockGroup,
    concat(element(ID.block, block), element(ID.blockDuration, unsigned(duration))),
  );

const blockPayload = (track: number, relative: number, data: Uint8Array): Uint8Array => {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = 0x80;
  return concat(header, data);
};

const cuePoint = (time: number, clusterOffset: number): Uint8Array =>
  element(
    ID.cuePoint,
    concat(
      element(ID.cueTime, unsigned(time)),
      element(
        ID.cueTrackPositions,
        concat(
          element(ID.cueTrack, unsigned(VIDEO)),
          element(ID.cueClusterPosition, unsigned(clusterOffset)),
        ),
      ),
    ),
  );

const compression = (algorithm: number, settings?: Uint8Array): Uint8Array =>
  element(
    ID.contentEncoding,
    element(
      ID.contentCompression,
      concat(
        element(ID.contentCompAlgo, unsigned(algorithm)),
        settings ? element(ID.contentCompSettings, settings) : new Uint8Array(),
      ),
    ),
  );

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const ascii = text;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const element = (id: number, payload: Uint8Array): Uint8Array =>
  concat(idBytes(id), sizeBytes(payload.length), payload);

const idBytes = (id: number): Uint8Array => {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Uint8Array.from(bytes);
};

const sizeBytes = (size: number): Uint8Array => {
  if (size < 0x7f) return Uint8Array.of(0x80 | size);
  if (size < 0x3fff) return Uint8Array.of(0x40 | (size >> 8), size & 0xff);
  return fixedSize4(size);
};

const fixedSize4 = (size: number): Uint8Array =>
  Uint8Array.of(0x10 | (size >> 24), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff);

const unsigned = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
