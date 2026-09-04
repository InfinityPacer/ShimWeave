import type {
  CapabilityEvidence,
  CapabilityProbeRequest,
  MediaCapabilitiesEvidence,
  MseTypeEvidence,
  VideoDecoderEvidence,
} from '@shimweave/contracts';

export type BrowserApiProbeRequest = Extract<
  CapabilityProbeRequest,
  { kind: 'mse-type' | 'media-capabilities' | 'video-decoder' }
>;

export type BrowserApiEvidence = Extract<
  CapabilityEvidence,
  { kind: 'mse-type' | 'media-capabilities' | 'video-decoder' }
>;

export interface BrowserCapabilityApis {
  now(): number;
  isMseTypeSupported(contentType: string): boolean | undefined;
  getVideoDecoderSupport(
    configuration: VideoDecoderConfig,
  ): Promise<{ supported?: boolean }> | undefined;
  getDecodingInfo(
    configuration: MediaDecodingConfiguration,
  ): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }> | undefined;
}

/** 浏览器 API 证据只在当前运行时会话复用；真实播放样本由独立持久缓存负责。 */
export class BrowserCapabilityProbe {
  private readonly pending = new Map<string, Promise<BrowserApiEvidence>>();

  constructor(private readonly apis: BrowserCapabilityApis = browserCapabilityApis()) {}

  probe(request: BrowserApiProbeRequest): Promise<BrowserApiEvidence> {
    const key = `${request.kind}:${request.path}:${request.configurationKey}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.run(request).catch((error: unknown) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, pending);
    return pending;
  }

  clear(): void {
    this.pending.clear();
  }

  private async run(request: BrowserApiProbeRequest): Promise<BrowserApiEvidence> {
    if (request.kind === 'mse-type') return this.probeMse(request);
    if (request.kind === 'video-decoder') return this.probeVideoDecoder(request);
    return this.probeMediaCapabilities(request);
  }

  private probeMse(
    request: Extract<BrowserApiProbeRequest, { kind: 'mse-type' }>,
  ): MseTypeEvidence {
    let support: MseTypeEvidence['support'];
    try {
      const supported = this.apis.isMseTypeSupported(request.contentType);
      support = supported === undefined ? 'unsupported' : supported ? 'supported' : 'unsupported';
    } catch {
      support = 'unknown';
    }
    return {
      kind: 'mse-type',
      path: request.path,
      configurationKey: request.configurationKey,
      contentType: request.contentType,
      support,
      observedAt: this.apis.now(),
    };
  }

  private async probeVideoDecoder(
    request: Extract<BrowserApiProbeRequest, { kind: 'video-decoder' }>,
  ): Promise<VideoDecoderEvidence> {
    let support: VideoDecoderEvidence['support'];
    try {
      const configuration: VideoDecoderConfig = {
        codec: request.configuration.codec,
        codedWidth: request.configuration.codedWidth,
        codedHeight: request.configuration.codedHeight,
        ...(request.configuration.description
          ? { description: request.configuration.description.slice() }
          : {}),
      };
      const result = await this.apis.getVideoDecoderSupport(configuration);
      support =
        result === undefined
          ? 'unsupported'
          : result.supported === true
            ? 'supported'
            : 'unsupported';
    } catch {
      support = 'unknown';
    }
    return {
      kind: 'video-decoder',
      path: request.path,
      configurationKey: request.configurationKey,
      support,
      observedAt: this.apis.now(),
    };
  }

  private async probeMediaCapabilities(
    request: Extract<BrowserApiProbeRequest, { kind: 'media-capabilities' }>,
  ): Promise<MediaCapabilitiesEvidence> {
    try {
      const result = await this.apis.getDecodingInfo(request.configuration);
      if (!result) {
        return {
          kind: 'media-capabilities',
          path: request.path,
          configurationKey: request.configurationKey,
          support: 'unknown',
          observedAt: this.apis.now(),
        };
      }
      return {
        kind: 'media-capabilities',
        path: request.path,
        configurationKey: request.configurationKey,
        support: result.supported ? 'supported' : 'unsupported',
        smooth: result.smooth,
        powerEfficient: result.powerEfficient,
        observedAt: this.apis.now(),
      };
    } catch {
      return {
        kind: 'media-capabilities',
        path: request.path,
        configurationKey: request.configurationKey,
        support: 'unknown',
        observedAt: this.apis.now(),
      };
    }
  }
}

const browserCapabilityApis = (): BrowserCapabilityApis => ({
  now: () => Date.now(),
  isMseTypeSupported: (contentType) =>
    typeof MediaSource === 'undefined' ? undefined : MediaSource.isTypeSupported(contentType),
  getVideoDecoderSupport: (configuration) =>
    typeof VideoDecoder === 'undefined' ? undefined : VideoDecoder.isConfigSupported(configuration),
  getDecodingInfo: (configuration) =>
    navigator.mediaCapabilities?.decodingInfo
      ? navigator.mediaCapabilities.decodingInfo(configuration)
      : undefined,
});
