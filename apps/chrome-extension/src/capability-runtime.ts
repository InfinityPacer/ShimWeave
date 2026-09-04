import type {
  CapabilityEvidence,
  CapabilityScope,
  CapabilitySnapshot,
  CodecTransform,
  PlanningResult,
  PlaybackIntent,
  SampleCapabilityEvidence,
} from '@shimweave/contracts';
import {
  CapabilitySampleCache,
  planPlayback,
  selectPreferredSampleEvidence,
} from '@shimweave/core';
import { type BrowserApiProbeRequest, BrowserCapabilityProbe } from './capability-probe.js';
import { IndexedDbSampleEvidenceRepository } from './indexeddb-sample-repository.js';

export interface BrowserCapabilityRuntimeOptions {
  scope: CapabilityScope;
  remuxContainers?: readonly string[];
  transforms?: readonly CodecTransform[];
  probe?: Pick<BrowserCapabilityProbe, 'probe' | 'clear'>;
  samples?: Pick<CapabilitySampleCache, 'peek' | 'get' | 'put' | 'prune' | 'close'>;
}

/** 不兼容音轨只在原始 MSE 路径失败后才降为确定的 AAC-LC 立体声。 */
const createAacFallback = (from: string): CodecTransform => ({
  kind: 'audio',
  from,
  to: 'aac',
  outputAudio: {
    codec: 'aac',
    codecString: 'mp4a.40.2',
    channels: 2,
    channelLayout: 'stereo',
    sampleRate: 48_000,
    bitrate: 192_000,
  },
});

const DEFAULT_TRANSFORMS: readonly CodecTransform[] = [
  createAacFallback('ac3'),
  createAacFallback('eac3'),
  createAacFallback('dts'),
];

/**
 * 运行时只自动执行低成本浏览器 API 探测。媒体深探测和真实播放由调用方显式驱动并回写样本。
 */
export class BrowserCapabilityRuntime {
  private readonly evidence = new Map<string, CapabilityEvidence>();
  private readonly probe: Pick<BrowserCapabilityProbe, 'probe' | 'clear'>;
  private readonly samples: Pick<CapabilitySampleCache, 'peek' | 'get' | 'put' | 'prune' | 'close'>;
  private readonly base: Omit<CapabilitySnapshot, 'evidence'>;

  constructor(options: BrowserCapabilityRuntimeOptions) {
    this.probe = options.probe ?? new BrowserCapabilityProbe();
    this.samples =
      options.samples ??
      new CapabilitySampleCache(options.scope, new IndexedDbSampleEvidenceRepository());
    this.base = {
      scope: options.scope,
      remuxContainers: options.remuxContainers ?? ['mp4'],
      transforms: options.transforms ?? DEFAULT_TRANSFORMS,
    };
  }

  async plan(intent: PlaybackIntent): Promise<PlanningResult> {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const result = planPlayback(intent, this.snapshot());
      if (result.status !== 'probe-required') return result;

      const candidate = result.candidate;
      if (candidate) {
        const hotSample = this.samples.peek(candidate.configurationKey, candidate.mediaFingerprint);
        if (hotSample) {
          this.addEvidence(hotSample);
          continue;
        }
      }

      const apiRequests = result.probes.filter(isBrowserApiProbeRequest);
      if (apiRequests.length > 0) {
        const probed = await Promise.all(apiRequests.map((request) => this.probe.probe(request)));
        for (const evidence of probed) this.addEvidence(evidence);
        continue;
      }

      const sampleRequest = result.probes.find((request) => request.kind === 'sample-playback');
      if (sampleRequest) {
        const persisted = await this.samples.get(
          sampleRequest.configurationKey,
          sampleRequest.mediaFingerprint,
        );
        if (persisted) {
          this.addEvidence(persisted);
          continue;
        }
      }
      return result;
    }
    throw new CapabilityPlanningLoopError();
  }

  async recordSample(evidence: SampleCapabilityEvidence): Promise<void> {
    this.addEvidence(evidence);
    await this.samples.put(evidence);
  }

  pruneSamples(): Promise<number> {
    return this.samples.prune();
  }

  clearSessionEvidence(): void {
    this.evidence.clear();
    this.probe.clear();
  }

  close(): void {
    this.evidence.clear();
    this.probe.clear();
    this.samples.close();
  }

  private snapshot(): CapabilitySnapshot {
    return { ...this.base, evidence: [...this.evidence.values()] };
  }

  private addEvidence(evidence: CapabilityEvidence): void {
    const key = evidenceIdentity(evidence);
    const existing = this.evidence.get(key);
    if (evidence.kind === 'sample') {
      if (evidence.support === 'unknown') {
        if (existing?.kind !== 'sample' || existing.support === 'unknown') {
          this.evidence.set(key, evidence);
        }
        return;
      }
      const selected = selectPreferredSampleEvidence(
        existing?.kind === 'sample' && existing.support !== 'unknown' ? existing : undefined,
        evidence,
      );
      this.evidence.set(key, selected);
      return;
    }
    if (!existing || existing.observedAt <= evidence.observedAt) this.evidence.set(key, evidence);
  }
}

export class CapabilityPlanningLoopError extends Error {
  constructor() {
    super('Capability planning did not converge');
    this.name = 'CapabilityPlanningLoopError';
  }
}

export const createBrowserCapabilityScope = (): CapabilityScope => ({
  schemaVersion: 2,
  runtimeKey: opaqueRuntimeKey(
    [
      navigator.userAgent,
      navigator.platform,
      String(navigator.hardwareConcurrency),
      String((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 'unknown'),
    ].join('|'),
  ),
  engineKey: `shimweave/${chrome.runtime.getManifest().version}|mediabunny/1.55.5`,
});

const isBrowserApiProbeRequest = (
  request: Parameters<BrowserCapabilityProbe['probe']>[0] | { kind: string },
): request is BrowserApiProbeRequest =>
  request.kind === 'mse-type' ||
  request.kind === 'media-capabilities' ||
  request.kind === 'video-decoder';

const evidenceIdentity = (evidence: CapabilityEvidence): string =>
  evidence.kind === 'sample'
    ? `${evidence.kind}:${evidence.path}:${evidence.configurationKey}:${evidence.mediaFingerprint}`
    : `${evidence.kind}:${evidence.path}:${evidence.configurationKey}`;

const opaqueRuntimeKey = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of new TextEncoder().encode(value)) {
    hash ^= BigInt(character);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};
