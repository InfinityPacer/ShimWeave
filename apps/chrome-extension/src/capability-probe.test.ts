import type { CapabilityProbeRequest } from '@shimweave/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserApiProbeRequest,
  type BrowserCapabilityApis,
  BrowserCapabilityProbe,
} from './capability-probe.js';

const request = <Kind extends BrowserApiProbeRequest['kind']>(
  kind: Kind,
): Extract<CapabilityProbeRequest, { kind: Kind }> => {
  if (kind === 'mse-type') {
    return {
      kind,
      path: 'mse-remux',
      configurationKey: 'configuration-a',
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
    } as Extract<CapabilityProbeRequest, { kind: Kind }>;
  }
  if (kind === 'video-decoder') {
    return {
      kind,
      path: 'webcodecs-video',
      configurationKey: 'configuration-a',
      configuration: {
        codec: 'hvc1.2.4.L153.B0',
        codedWidth: 3840,
        codedHeight: 2160,
        description: Uint8Array.from([1, 2, 3]),
      },
    } as Extract<CapabilityProbeRequest, { kind: Kind }>;
  }
  return {
    kind,
    path: 'mse-remux',
    configurationKey: 'configuration-a',
    configuration: {
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
        width: 3840,
        height: 2160,
        bitrate: 12_000_000,
        framerate: 24,
      },
    },
  } as Extract<CapabilityProbeRequest, { kind: Kind }>;
};

const apis = (overrides: Partial<BrowserCapabilityApis> = {}): BrowserCapabilityApis => ({
  now: () => 100,
  isMseTypeSupported: () => true,
  getVideoDecoderSupport: async () => ({ supported: true }),
  getDecodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }),
  ...overrides,
});

describe('BrowserCapabilityProbe', () => {
  it('记录精确 MSE content type 并复用同一会话探测', async () => {
    const isMseTypeSupported = vi.fn(() => true);
    const probe = new BrowserCapabilityProbe(apis({ isMseTypeSupported }));
    const mediaSourceRequest = request('mse-type');

    const [first, second] = await Promise.all([
      probe.probe(mediaSourceRequest),
      probe.probe(mediaSourceRequest),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'mse-type',
      path: 'mse-remux',
      configurationKey: 'configuration-a',
      support: 'supported',
      observedAt: 100,
    });
    expect(isMseTypeSupported).toHaveBeenCalledOnce();
  });

  it('API 缺失与执行异常使用不同语义', async () => {
    const missing = new BrowserCapabilityProbe(apis({ isMseTypeSupported: () => undefined }));
    await expect(missing.probe(request('mse-type'))).resolves.toMatchObject({
      support: 'unsupported',
    });

    const failed = new BrowserCapabilityProbe(
      apis({
        isMseTypeSupported: () => {
          throw new TypeError('invalid runtime state');
        },
      }),
    );
    await expect(failed.probe(request('mse-type'))).resolves.toMatchObject({ support: 'unknown' });
  });

  it('WebCodecs 只产生 webcodecs-video 路径证据并复制 description', async () => {
    let received: VideoDecoderConfig | undefined;
    const probe = new BrowserCapabilityProbe(
      apis({
        getVideoDecoderSupport: async (configuration) => {
          received = configuration;
          if (configuration.description instanceof Uint8Array) configuration.description[0] = 9;
          return { supported: false };
        },
      }),
    );
    const decoderRequest = request('video-decoder');
    const result = await probe.probe(decoderRequest);

    expect(result).toMatchObject({
      kind: 'video-decoder',
      path: 'webcodecs-video',
      support: 'unsupported',
    });
    expect(received?.codec).toBe('hvc1.2.4.L153.B0');
    expect(decoderRequest.configuration.description?.[0]).toBe(1);
  });

  it('MediaCapabilities 保存支持、流畅和省电三类证据', async () => {
    const probe = new BrowserCapabilityProbe(apis());
    await expect(probe.probe(request('media-capabilities'))).resolves.toMatchObject({
      kind: 'media-capabilities',
      support: 'supported',
      smooth: true,
      powerEfficient: true,
    });
  });

  it('MediaCapabilities 不可用或失败时保持 unknown', async () => {
    const unavailable = new BrowserCapabilityProbe(apis({ getDecodingInfo: () => undefined }));
    await expect(unavailable.probe(request('media-capabilities'))).resolves.toMatchObject({
      support: 'unknown',
    });

    const failed = new BrowserCapabilityProbe(
      apis({ getDecodingInfo: async () => Promise.reject(new Error('probe failed')) }),
    );
    await expect(failed.probe(request('media-capabilities'))).resolves.toMatchObject({
      support: 'unknown',
    });
  });

  it('clear 使低成本 API 探测可在运行时变化后重新执行', async () => {
    const isMseTypeSupported = vi.fn(() => true);
    const probe = new BrowserCapabilityProbe(apis({ isMseTypeSupported }));
    const mediaSourceRequest = request('mse-type');
    await probe.probe(mediaSourceRequest);
    probe.clear();
    await probe.probe(mediaSourceRequest);
    expect(isMseTypeSupported).toHaveBeenCalledTimes(2);
  });
});
