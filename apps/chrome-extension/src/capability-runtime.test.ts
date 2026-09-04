import type {
  CapabilityScope,
  PlaybackIntent,
  SampleCapabilityEvidence,
} from '@shimweave/contracts';
import type { CacheableSampleEvidence } from '@shimweave/core';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserApiEvidence } from './capability-probe.js';
import { BrowserCapabilityRuntime } from './capability-runtime.js';

const scope: CapabilityScope = {
  schemaVersion: 1,
  runtimeKey: 'runtime-a',
  engineKey: 'engine-a',
};

const intent = (): PlaybackIntent => ({
  media: {
    sourceId: 'source-a',
    sizeBytes: 1000,
    container: 'matroska',
    tracks: [
      {
        id: 'video-1',
        kind: 'video',
        codec: 'hevc',
        codecString: 'hvc1.2.4.L153.B0',
        codedWidth: 3840,
        codedHeight: 2160,
      },
      {
        id: 'audio-1',
        kind: 'audio',
        codec: 'aac',
        codecString: 'mp4a.40.2',
      },
    ],
  },
});

const createSamples = () => {
  const memory = new Map<string, CacheableSampleEvidence>();
  return {
    memory,
    peek: vi.fn((configurationKey: string, mediaFingerprint: string) =>
      memory.get(`${configurationKey}:${mediaFingerprint}`),
    ),
    get: vi.fn(async (configurationKey: string, mediaFingerprint: string) =>
      memory.get(`${configurationKey}:${mediaFingerprint}`),
    ),
    put: vi.fn(async (evidence: SampleCapabilityEvidence) => {
      if (evidence.support === 'unknown') return false;
      memory.set(`${evidence.configurationKey}:${evidence.mediaFingerprint}`, evidence);
      return true;
    }),
    prune: vi.fn(async () => 0),
    close: vi.fn(),
  };
};

describe('BrowserCapabilityRuntime', () => {
  it('自动执行低成本 API 探测并收敛到 MSE 播放计划', async () => {
    const probe = {
      probe: vi.fn(
        async (request): Promise<BrowserApiEvidence> => ({
          kind: 'mse-type',
          path: request.path,
          configurationKey: request.configurationKey,
          contentType: request.kind === 'mse-type' ? request.contentType : '',
          support: 'supported',
          observedAt: 1,
        }),
      ),
      clear: vi.fn(),
    };
    const runtime = new BrowserCapabilityRuntime({ scope, probe, samples: createSamples() });

    await expect(runtime.plan(intent())).resolves.toMatchObject({
      status: 'ready',
      plan: { strategy: 'remux', path: 'mse-remux' },
    });
    expect(probe.probe).toHaveBeenCalledOnce();
  });

  it('L1 真实样本命中时不调用浏览器 API', async () => {
    const samples = createSamples();
    let capturedKey = '';
    let capturedFingerprint = '';
    samples.peek.mockImplementation((configurationKey, mediaFingerprint) => {
      capturedKey = configurationKey;
      capturedFingerprint = mediaFingerprint;
      return {
        kind: 'sample',
        path: 'mse-remux',
        configurationKey,
        mediaFingerprint,
        support: 'supported',
        milestone: 'steady-playback',
        observedAt: 2,
      };
    });
    const probe = { probe: vi.fn(), clear: vi.fn() };
    const runtime = new BrowserCapabilityRuntime({ scope, probe, samples });

    await expect(runtime.plan(intent())).resolves.toMatchObject({
      status: 'ready',
      evidence: ['sample:steady-playback'],
    });
    expect(capturedKey).not.toBe('');
    expect(capturedFingerprint).not.toBe('');
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('API 证据冲突时查询 L2，仍未命中才请求真实播放', async () => {
    const samples = createSamples();
    const probe = {
      probe: vi.fn(async (request): Promise<BrowserApiEvidence> => {
        if (request.kind === 'mse-type') {
          return {
            kind: 'mse-type',
            path: request.path,
            configurationKey: request.configurationKey,
            contentType: request.contentType,
            support: 'unknown',
            observedAt: 1,
          };
        }
        throw new Error('Unexpected probe');
      }),
      clear: vi.fn(),
    };
    const runtime = new BrowserCapabilityRuntime({ scope, probe, samples });
    const result = await runtime.plan(intent());

    expect(result).toMatchObject({
      status: 'probe-required',
      probes: [{ kind: 'sample-playback' }],
    });
    expect(samples.get).toHaveBeenCalledOnce();
  });

  it('记录确定性样本供后续规划使用，瞬态失败只保留当前会话语义', async () => {
    const samples = createSamples();
    const runtime = new BrowserCapabilityRuntime({
      scope,
      probe: { probe: vi.fn(), clear: vi.fn() },
      samples,
    });
    const evidence: SampleCapabilityEvidence = {
      kind: 'sample',
      path: 'mse-remux',
      configurationKey: 'configuration-a',
      mediaFingerprint: 'media-a',
      support: 'supported',
      milestone: 'first-frame',
      observedAt: 1,
    };
    await runtime.recordSample(evidence);
    expect(samples.put).toHaveBeenCalledWith(evidence);

    const transient: SampleCapabilityEvidence = {
      kind: 'sample',
      path: 'mse-remux',
      configurationKey: 'configuration-a',
      mediaFingerprint: 'media-a',
      support: 'unknown',
      failureClass: 'cancelled',
      observedAt: 2,
    };
    await runtime.recordSample(transient);
    expect(samples.put).toHaveBeenCalledWith(transient);
  });

  it('局部解码失败不会在当前会话覆盖已经验证的成功路径', async () => {
    const probe = {
      probe: vi.fn(
        async (request): Promise<BrowserApiEvidence> => ({
          kind: 'mse-type',
          path: request.path,
          configurationKey: request.configurationKey,
          contentType: request.kind === 'mse-type' ? request.contentType : '',
          support: 'supported',
          observedAt: 1,
        }),
      ),
      clear: vi.fn(),
    };
    const runtime = new BrowserCapabilityRuntime({ scope, probe, samples: createSamples() });
    const initial = await runtime.plan(intent());
    expect(initial.status).toBe('ready');
    if (initial.status !== 'ready') throw new Error('Expected a ready plan');

    await runtime.recordSample({
      kind: 'sample',
      path: initial.plan.path,
      configurationKey: initial.plan.configurationKey,
      mediaFingerprint: initial.plan.mediaFingerprint,
      support: 'supported',
      milestone: 'steady-playback',
      observedAt: 100,
    });
    await runtime.recordSample({
      kind: 'sample',
      path: initial.plan.path,
      configurationKey: initial.plan.configurationKey,
      mediaFingerprint: initial.plan.mediaFingerprint,
      support: 'unsupported',
      failureClass: 'decode',
      observedAt: 200,
    });

    await expect(runtime.plan(intent())).resolves.toMatchObject({
      status: 'ready',
      evidence: ['sample:steady-playback'],
    });
  });

  it('关闭时释放 API memo 与持久缓存句柄', () => {
    const samples = createSamples();
    const probe = { probe: vi.fn(), clear: vi.fn() };
    const runtime = new BrowserCapabilityRuntime({ scope, probe, samples });
    runtime.close();
    expect(probe.clear).toHaveBeenCalledOnce();
    expect(samples.close).toHaveBeenCalledOnce();
  });
});
