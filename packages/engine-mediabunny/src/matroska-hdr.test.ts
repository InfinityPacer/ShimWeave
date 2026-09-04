import { describe, expect, it } from 'vitest';
import { readMatroskaTrackMetadata } from './matroska-hdr.js';

const ID = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  defaultDuration: 0x23e383,
  blockAdditionMapping: 0x41e4,
  blockAddIdType: 0x41e7,
  blockAddIdExtraData: 0x41ed,
  video: 0xe0,
  colour: 0x55b0,
  maxCll: 0x55bc,
  maxFall: 0x55bd,
  masteringMetadata: 0x55d0,
  primaryRChromaticityX: 0x55d1,
  luminanceMax: 0x55d9,
} as const;

describe('readMatroskaTrackMetadata', () => {
  it('从视频 TrackEntry 读取 Dolby Vision 与静态 HDR 字段', async () => {
    const mastering = element(
      ID.masteringMetadata,
      concat(
        element(ID.primaryRChromaticityX, float64(0.68)),
        element(ID.luminanceMax, float64(1000)),
      ),
    );
    const colour = element(
      ID.colour,
      concat(element(ID.maxCll, unsigned(1000)), element(ID.maxFall, unsigned(400)), mastering),
    );
    const mapping = element(
      ID.blockAdditionMapping,
      concat(
        element(ID.blockAddIdType, unsigned(0x64767643)),
        element(ID.blockAddIdExtraData, Uint8Array.from([1, 0, 16, 48, 16])),
      ),
    );
    const file = element(
      ID.segment,
      element(ID.tracks, trackEntry(7, concat(mapping, element(ID.video, colour)))),
    );

    const metadata = await readMatroskaTrackMetadata(readerFor(file), file.length);

    expect(metadata.get(7)).toEqual({
      hdr: {
        kind: 'dolby-vision',
        profile: 8,
        level: 6,
        compatibilityId: 1,
        hasHdr10BaseLayer: true,
        masteringDisplay: 'rx=0.68,lmax=1000',
        maxContentLightLevel: 1000,
        maxFrameAverageLightLevel: 400,
      },
    });
  });

  it('只有静态亮度字段时保持 HDR 类型未知', async () => {
    const colour = element(ID.colour, element(ID.maxCll, unsigned(600)));
    const file = element(ID.segment, element(ID.tracks, trackEntry(2, element(ID.video, colour))));

    const metadata = await readMatroskaTrackMetadata(readerFor(file), file.length);

    expect(metadata.get(2)).toEqual({
      hdr: { kind: 'hdr-unknown', maxContentLightLevel: 600 },
    });
  });

  it('从 DefaultDuration 读取无需扫描 Cluster 的标称帧率', async () => {
    const file = element(
      ID.segment,
      element(
        ID.tracks,
        trackEntry(4, element(ID.defaultDuration, unsigned(41_708_333)), 1, 'V_MPEG4/ISO/AVC'),
      ),
    );

    const metadata = await readMatroskaTrackMetadata(readerFor(file), file.length);

    expect(metadata.get(4)?.frameRate).toEqual({
      numerator: 1_000_000_000,
      denominator: 41_708_333,
    });
  });

  it('通过 SeekHead 定位远端 Tracks，且总读取窗口有界', async () => {
    const tracksPosition = 1_100_000;
    const tracks = element(
      ID.tracks,
      trackEntry(
        3,
        element(
          ID.blockAdditionMapping,
          concat(
            element(ID.blockAddIdType, unsigned(0x64766343)),
            element(ID.blockAddIdExtraData, Uint8Array.from([1, 0, 10, 40, 0])),
          ),
        ),
      ),
    );
    const seek = element(
      ID.seek,
      concat(
        element(ID.seekId, idBytes(ID.tracks)),
        element(ID.seekPosition, unsigned(tracksPosition)),
      ),
    );
    const prefix = concat(idBytes(ID.segment), Uint8Array.of(0xff), element(ID.seekHead, seek));
    const segmentDataStart = idBytes(ID.segment).length + 1;
    const file = new Uint8Array(segmentDataStart + tracksPosition + tracks.length);
    file.set(prefix);
    file.set(tracks, segmentDataStart + tracksPosition);
    const reads: Array<{ start: number; end: number }> = [];

    const metadata = await readMatroskaTrackMetadata(
      {
        read: async (start, end) => {
          reads.push({ start, end });
          return file.slice(start, end);
        },
      },
      file.length,
    );

    expect(metadata.get(3)?.hdr).toMatchObject({ kind: 'dolby-vision', profile: 5, level: 5 });
    expect(reads).toEqual([
      { start: 0, end: 512 * 1024 },
      { start: segmentDataStart + tracksPosition, end: file.length },
    ]);
  });

  it('忽略非视频、非 HEVC 和非法 Dolby Vision 配置', async () => {
    const badMapping = element(
      ID.blockAdditionMapping,
      concat(
        element(ID.blockAddIdType, unsigned(0x64767643)),
        element(ID.blockAddIdExtraData, Uint8Array.from([1, 0, 0xff, 0xff])),
      ),
    );
    const audio = trackEntry(1, badMapping, 2, 'A_EAC3');
    const invalidVideo = trackEntry(2, badMapping);
    const file = element(ID.segment, element(ID.tracks, concat(audio, invalidVideo)));

    const metadata = await readMatroskaTrackMetadata(readerFor(file), file.length);

    expect(metadata.size).toBe(0);
  });
});

const trackEntry = (
  number: number,
  extra: Uint8Array,
  type = 1,
  codec = 'V_MPEGH/ISO/HEVC',
): Uint8Array =>
  element(
    ID.trackEntry,
    concat(
      element(ID.trackNumber, unsigned(number)),
      element(ID.trackType, unsigned(type)),
      element(ID.codecId, new TextEncoder().encode(codec)),
      extra,
    ),
  );

const readerFor = (bytes: Uint8Array) => ({
  read: async (start: number, end: number) => bytes.slice(start, end),
});

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
  if (size < 0x1fffff) {
    return Uint8Array.of(0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff);
  }
  throw new RangeError('Test element is too large');
};

const unsigned = (value: number): Uint8Array => {
  const bytes: number[] = [];
  do {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  } while (value > 0);
  return Uint8Array.from(bytes);
};

const float64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return bytes;
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
