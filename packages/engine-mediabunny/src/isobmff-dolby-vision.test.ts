import { describe, expect, it } from 'vitest';
import { readIsobmffDolbyVisionTrackMetadata } from './isobmff-dolby-vision.js';

describe('readIsobmffDolbyVisionTrackMetadata', () => {
  it('从 dvh1 sample entry 的 dvcC 与 hvcC 补齐精确能力事实', async () => {
    const hvcC = new Uint8Array(23);
    hvcC[0] = 1;
    hvcC[16] = 1;
    hvcC[17] = 2;
    const file = mp4File(7, 'dvh1', box('hvcC', hvcC), box('dvcC', dovi(5, 6, 0)));

    const metadata = await readIsobmffDolbyVisionTrackMetadata(readerFor(file), file.length);

    expect(metadata.get(7)).toEqual({
      codecString: 'dvh1.05.06',
      hdr: { kind: 'dolby-vision', profile: 5, level: 6, compatibilityId: 0 },
      decoderDescription: hvcC,
      bitDepth: 10,
      chromaSubsampling: '4:2:0',
    });
  });

  it('跳过前置 mdat 并保留 HDR10 基层兼容事实', async () => {
    const prefix = concat(box('ftyp', ascii('isom')), sizedBox('mdat', 1_100_000));
    const moov = moovBox(3, 'dvhe', box('dvvC', dovi(8, 6, 1)));
    const file = new Uint8Array(prefix.length + moov.length);
    file.set(prefix);
    file.set(moov, prefix.length);
    const reads: Array<{ start: number; end: number }> = [];

    const metadata = await readIsobmffDolbyVisionTrackMetadata(
      {
        read: async (start, end) => {
          reads.push({ start, end });
          return file.slice(start, end);
        },
      },
      file.length,
    );

    expect(metadata.get(3)).toMatchObject({
      codecString: 'dvhe.08.06',
      hdr: {
        kind: 'dolby-vision',
        profile: 8,
        level: 6,
        compatibilityId: 1,
        hasHdr10BaseLayer: true,
      },
    });
    expect(reads.some(({ start, end }) => start === 12 && end - start === 16)).toBe(true);
    expect(reads.some(({ start }) => start > 12 && start < prefix.length)).toBe(false);
  });

  it('sample entry 位于大型 moov 前部时只读取首个有界窗口', async () => {
    const smallMoov = moovBox(9, 'dvh1', box('dvcC', dovi(5, 6, 0)));
    const largeMoov = box('moov', concat(smallMoov.subarray(8), sizedBox('free', 1024 * 1024)));
    const prefix = box('ftyp', ascii('isom'));
    const file = concat(prefix, largeMoov);
    const reads: Array<{ start: number; end: number }> = [];

    const metadata = await readIsobmffDolbyVisionTrackMetadata(
      {
        read: async (start, end) => {
          reads.push({ start, end });
          return file.slice(start, end);
        },
      },
      file.length,
    );

    expect(metadata.get(9)?.codecString).toBe('dvh1.05.06');
    expect(reads.at(-1)).toEqual({ start: prefix.length, end: prefix.length + 512 * 1024 });
  });

  it('忽略没有 Dolby Vision 配置盒和非法 box 尺寸的输入', async () => {
    const plain = mp4File(1, 'hvc1', box('hvcC', new Uint8Array(23)));
    const malformed = Uint8Array.of(0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x76);

    await expect(
      readIsobmffDolbyVisionTrackMetadata(readerFor(plain), plain.length),
    ).resolves.toEqual(new Map());
    await expect(
      readIsobmffDolbyVisionTrackMetadata(readerFor(malformed), malformed.length),
    ).resolves.toEqual(new Map());
  });
});

const mp4File = (trackId: number, sampleEntry: string, ...children: Uint8Array[]): Uint8Array =>
  concat(box('ftyp', ascii('isom')), moovBox(trackId, sampleEntry, ...children));

const moovBox = (trackId: number, sampleEntry: string, ...children: Uint8Array[]): Uint8Array => {
  const tkhd = new Uint8Array(20);
  new DataView(tkhd.buffer).setUint32(12, trackId);
  const visualFields = new Uint8Array(78);
  const entry = box(sampleEntry, concat(visualFields, ...children));
  const stsd = box('stsd', concat(new Uint8Array(4), u32(1), entry));
  return box(
    'moov',
    box('trak', concat(box('tkhd', tkhd), box('mdia', box('minf', box('stbl', stsd))))),
  );
};

const dovi = (profile: number, level: number, compatibilityId: number): Uint8Array =>
  Uint8Array.of(
    1,
    0,
    (profile << 1) | ((level >> 5) & 0x01),
    ((level & 0x1f) << 3) | 0x05,
    (compatibilityId & 0x0f) << 4,
  );

const sizedBox = (type: string, size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(ascii(type), 4);
  return bytes;
};

const box = (type: string, payload: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(ascii(type), 4);
  bytes.set(payload, 8);
  return bytes;
};

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const readerFor = (bytes: Uint8Array) => ({
  read: async (start: number, end: number) => bytes.slice(start, end),
});
