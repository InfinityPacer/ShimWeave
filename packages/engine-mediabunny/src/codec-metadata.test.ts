import { describe, expect, it } from 'vitest';
import {
  copyDecoderDescription,
  fingerprintBytes,
  inferHdrConfiguration,
  parseCodecMetadata,
  selectCodecParameterString,
} from './codec-metadata.js';

describe('parseCodecMetadata', () => {
  it('用 decoder config 补全容器中的简写 codec', () => {
    expect(selectCodecParameterString('dvh1', 'dvh1.05.06')).toBe('dvh1.05.06');
    expect(selectCodecParameterString('hvc1.2.4.L153.B0', 'hvc1.2.4.L153.B0')).toBe(
      'hvc1.2.4.L153.B0',
    );
    expect(selectCodecParameterString('hev1.2.4.L153.B0', 'hvc1.2.4.L153.B0')).toBe(
      'hev1.2.4.L153.B0',
    );
  });

  it('解析 AVC profile 和 level', () => {
    expect(parseCodecMetadata('avc1.640028', undefined)).toEqual({
      profile: 'high',
      level: '4.0',
    });
  });

  it('从 HEVC codec string 与 hvcC 补足 profile、level、位深和色度', () => {
    const hvcC = new Uint8Array(19);
    hvcC[0] = 1;
    hvcC[1] = 0x22;
    hvcC[12] = 153;
    hvcC[16] = 1;
    hvcC[17] = 2;

    expect(parseCodecMetadata('hvc1.2.4.L153.B0', hvcC)).toEqual({
      profile: 'main-10',
      level: '5.1',
      tier: 'L',
      bitDepth: 10,
      chromaSubsampling: '4:2:0',
    });
  });

  it('区分 AV1、VP9、Dolby Vision 和 AAC profile', () => {
    expect(parseCodecMetadata('av01.0.08M.10', undefined)).toMatchObject({
      profile: '0',
      level: '08',
      tier: 'M',
      bitDepth: 10,
    });
    expect(parseCodecMetadata('vp09.02.10.10', undefined)).toMatchObject({
      profile: '02',
      level: '10',
      bitDepth: 10,
    });
    expect(parseCodecMetadata('dvh1.05.06', undefined)).toEqual({
      profile: '5',
      level: '6',
      hdr: { kind: 'dolby-vision', profile: 5, level: 6 },
    });
    expect(parseCodecMetadata('mp4a.40.2', undefined)).toEqual({ profile: 'aac-lc' });
  });
});

describe('HDR and decoder identities', () => {
  it('只把可证的 HLG 和 DV 分类，PQ 保持 HDR 类型未知', () => {
    expect(inferHdrConfiguration('hvc1.2.4.L153.B0', { transfer: 'hlg' }, true)).toEqual({
      kind: 'hlg',
    });
    expect(inferHdrConfiguration('hvc1.2.4.L153.B0', { transfer: 'pq' }, true)).toEqual({
      kind: 'hdr-unknown',
    });
    expect(inferHdrConfiguration('dvhe.08.06', { transfer: 'pq' }, true)).toEqual({
      kind: 'dolby-vision',
      profile: 8,
      level: 6,
    });
  });

  it('复制 decoder description，避免共享字节被调用方修改', () => {
    const original = Uint8Array.from([1, 2, 3]);
    const copied = copyDecoderDescription(original);
    expect(copied).toEqual(original);
    if (!copied) throw new Error('Expected copied description');
    copied[0] = 9;
    expect(original[0]).toBe(1);
  });

  it('decoder description 摘要稳定且内容变化即失效', () => {
    expect(fingerprintBytes(Uint8Array.from([1, 2, 3]))).toBe(
      fingerprintBytes(Uint8Array.from([1, 2, 3])),
    );
    expect(fingerprintBytes(Uint8Array.from([1, 2, 3]))).not.toBe(
      fingerprintBytes(Uint8Array.from([1, 2, 4])),
    );
  });
});
