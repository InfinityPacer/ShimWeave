import type {
  MediaDescriptor,
  MediaSourceDescriptor,
  PlanningResult,
  PlaybackPlan,
  SampleCapabilityEvidence,
} from '@shimweave/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { MediaWorkerStream } from './media-worker-client.js';
import {
  BrowserPlaybackRuntime,
  BrowserPlaybackSupersededError,
  BrowserPlaybackUnsupportedError,
} from './playback-runtime.js';

const descriptor: MediaDescriptor = {
  sourceId: 'source-a',
  sizeBytes: 1_000,
  container: 'matroska',
  mimeType: 'video/x-matroska',
  tracks: [
    {
      id: 'video-2',
      kind: 'video',
      codec: 'hevc',
      codecString: 'hvc1.2.4.L153.B0',
      codedWidth: 3840,
      codedHeight: 2160,
    },
    {
      id: 'audio-4',
      kind: 'audio',
      codec: 'eac3',
      codecString: 'ec-3',
    },
  ],
};

const outputAudio = {
  codec: 'aac' as const,
  codecString: 'mp4a.40.2',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
  bitrate: 192_000,
};

const plan: PlaybackPlan = {
  strategy: 'remux-audio-transcode',
  path: 'mse-remux-audio-transcode',
  configurationKey: 'configuration-a',
  mediaFingerprint: 'fingerprint-a',
  outputContainer: 'mp4',
  videoTrackId: 'video-2',
  audioTrackId: 'audio-4',
  outputAudio,
};

class TestMediaElement extends EventTarget {
  src = '';
  currentTime = 0;
  readyState = 2;
  paused = false;
  seeking = false;
  buffered: TimeRanges = ranges([[0, 100]]);
  error: MediaError | null = null;
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly load = vi.fn();

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

class TestWorker {
  readonly whenReady = vi.fn(async () => undefined);
  readonly describe = vi.fn(async () => descriptor);
  readonly startStream = vi.fn(async () => stream());
  readonly close = vi.fn(async () => undefined);
}

describe('BrowserPlaybackRuntime', () => {
  it('把待真实播放验证的能力计划接入 Worker、MSE 和样本记录', async () => {
    const media = new TestMediaElement();
    const worker = new TestWorker();
    const recordSample = vi.fn(async (_evidence: SampleCapabilityEvidence) => undefined);
    const mseCompletion = deferred<void>();
    const stopMse = vi.fn(async () => undefined);
    const startMse = vi.fn(async () => ({ completion: mseCompletion.promise, stop: stopMse }));
    const planning: PlanningResult = {
      status: 'probe-required',
      candidate: plan,
      probes: [
        {
          kind: 'sample-playback',
          path: plan.path,
          configurationKey: plan.configurationKey,
          mediaFingerprint: plan.mediaFingerprint,
        },
      ],
    };
    let now = 100;
    const runtime = new BrowserPlaybackRuntime({
      capabilities: { plan: vi.fn(async () => planning), recordSample },
      createWorker: () => worker,
      createMseController: () => ({ start: startMse, stop: stopMse }),
      now: () => now++,
      steadyPlaybackSeconds: 5,
    });

    const active = await runtime.start({
      source: directSource('source-a', 'https://cdn.example/media'),
      mediaElement: media as unknown as HTMLMediaElement,
      startSeconds: 12,
    });

    expect(active.plan).toEqual(plan);
    expect(worker.startStream).toHaveBeenCalledWith({
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
      outputAudio,
      startSeconds: 12,
    });
    expect(startMse).toHaveBeenCalledOnce();

    media.currentTime = 1;
    media.dispatchEvent(new Event('playing'));
    media.currentTime = 7;
    media.dispatchEvent(new Event('timeupdate'));
    media.seeking = true;
    media.dispatchEvent(new Event('seeking'));
    media.seeking = false;
    media.dispatchEvent(new Event('seeked'));
    media.currentTime = 7.1;
    media.dispatchEvent(new Event('timeupdate'));
    await flush();

    expect(recordSample.mock.calls.map(([item]) => item)).toEqual([
      expect.objectContaining({ support: 'supported', milestone: 'first-frame' }),
      expect.objectContaining({ support: 'supported', milestone: 'steady-playback' }),
      expect.objectContaining({ support: 'supported', milestone: 'seek-resume' }),
    ]);
    await active.stop();
    expect(stopMse).toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it('缓冲外 Seek 复用 Worker 重建最后目标，真实推进后才记录成功', async () => {
    const media = new TestMediaElement();
    media.buffered = ranges([[0, 10]]);
    const worker = new TestWorker();
    const recordSample = vi.fn(async (_evidence: SampleCapabilityEvidence) => undefined);
    const firstStop = vi.fn(async () => {
      media.currentTime = 0;
      media.readyState = 0;
      media.dispatchEvent(new Event('seeking'));
    });
    const secondStop = vi.fn(async () => undefined);
    const controllers = [
      {
        start: vi.fn(async () => ({
          completion: new Promise<void>(() => undefined),
          stop: firstStop,
        })),
        stop: firstStop,
      },
      {
        start: vi.fn(async () => ({
          completion: new Promise<void>(() => undefined),
          stop: secondStop,
        })),
        stop: secondStop,
      },
    ];
    const planning: PlanningResult = {
      status: 'probe-required',
      candidate: plan,
      probes: [
        {
          kind: 'sample-playback',
          path: plan.path,
          configurationKey: plan.configurationKey,
          mediaFingerprint: plan.mediaFingerprint,
        },
      ],
    };
    const runtime = new BrowserPlaybackRuntime({
      capabilities: {
        plan: vi.fn(async () => planning),
        recordSample,
      },
      createWorker: () => worker,
      createMseController: () => {
        const controller = controllers.shift();
        if (!controller) throw new Error('Unexpected MSE controller');
        return controller;
      },
    });
    const active = await runtime.start({
      source: directSource('source-a', 'https://cdn.example/media'),
      mediaElement: media as unknown as HTMLMediaElement,
    });
    media.dispatchEvent(new Event('playing'));
    media.currentTime = 100;
    media.seeking = true;
    media.dispatchEvent(new Event('seeking'));
    await flush();

    expect(firstStop).toHaveBeenCalledOnce();
    expect(worker.startStream).toHaveBeenNthCalledWith(2, {
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
      outputAudio,
      startSeconds: 100,
    });
    expect(recordSample).not.toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 'seek-resume' }),
    );

    media.readyState = 2;
    media.seeking = false;
    media.dispatchEvent(new Event('seeked'));
    media.currentTime = 100.1;
    media.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(recordSample).toHaveBeenCalledWith(
      expect.objectContaining({ support: 'supported', milestone: 'seek-resume' }),
    );

    await active.stop();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it('连续缓冲外 Seek 只为最后目标建立新流', async () => {
    const media = new TestMediaElement();
    media.buffered = ranges([[0, 10]]);
    const worker = new TestWorker();
    const stopped = deferred<void>();
    const firstStop = vi.fn(() => stopped.promise);
    const secondStop = vi.fn(async () => undefined);
    const controllers = [
      {
        start: vi.fn(async () => ({
          completion: new Promise<void>(() => undefined),
          stop: firstStop,
        })),
        stop: firstStop,
      },
      {
        start: vi.fn(async () => ({
          completion: new Promise<void>(() => undefined),
          stop: secondStop,
        })),
        stop: secondStop,
      },
    ];
    const runtime = new BrowserPlaybackRuntime({
      capabilities: {
        plan: vi.fn(async () => ({ status: 'ready', plan, evidence: [] }) as PlanningResult),
        recordSample: vi.fn(async () => undefined),
      },
      createWorker: () => worker,
      createMseController: () => {
        const controller = controllers.shift();
        if (!controller) throw new Error('Unexpected MSE controller');
        return controller;
      },
    });
    const active = await runtime.start({
      source: directSource('source-a', 'https://cdn.example/media'),
      mediaElement: media as unknown as HTMLMediaElement,
    });
    media.dispatchEvent(new Event('playing'));
    media.currentTime = 100;
    media.dispatchEvent(new Event('seeking'));
    await flush();
    expect(firstStop).toHaveBeenCalledOnce();

    media.currentTime = 200;
    media.dispatchEvent(new Event('seeking'));
    stopped.resolve();
    await flush();

    expect(worker.startStream).toHaveBeenCalledTimes(2);
    expect(worker.startStream).toHaveBeenNthCalledWith(2, {
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
      outputAudio,
      startSeconds: 200,
    });
    await active.stop();
  });

  it('原生路径使用源地址播放，描述完成后立即释放 Worker', async () => {
    const media = new TestMediaElement();
    const worker = new TestWorker();
    const nativePlan: PlaybackPlan = {
      strategy: 'native',
      path: 'native-file',
      configurationKey: 'native-configuration',
      mediaFingerprint: 'fingerprint-a',
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
    };
    const planning: PlanningResult = { status: 'ready', plan: nativePlan, evidence: [] };
    const runtime = new BrowserPlaybackRuntime({
      capabilities: {
        plan: vi.fn(async () => planning),
        recordSample: vi.fn(async () => undefined),
      },
      createWorker: () => worker,
    });

    const active = await runtime.start({
      source: directSource('source-a', 'https://cdn.example/native.mp4', true),
      mediaElement: media as unknown as HTMLMediaElement,
    });

    expect(media.src).toBe('https://cdn.example/native.mp4');
    expect(media.load).toHaveBeenCalledOnce();
    expect(media.play).toHaveBeenCalledOnce();
    expect(worker.startStream).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledOnce();
    await active.stop();
    expect(media.src).toBe('');
    expect(media.pause).toHaveBeenCalledOnce();
  });

  it('不支持的计划不会启动媒体，并释放探测 Worker', async () => {
    const worker = new TestWorker();
    const planning: PlanningResult = { status: 'unsupported', reason: 'no_path', evidence: [] };
    const runtime = new BrowserPlaybackRuntime({
      capabilities: {
        plan: vi.fn(async () => planning),
        recordSample: vi.fn(async () => undefined),
      },
      createWorker: () => worker,
    });

    await expect(
      runtime.start({
        source: directSource('source-a', 'https://cdn.example/media'),
        mediaElement: new TestMediaElement() as unknown as HTMLMediaElement,
      }),
    ).rejects.toBeInstanceOf(BrowserPlaybackUnsupportedError);
    expect(worker.startStream).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it('快速切换会取消未完成描述，旧请求不能接管播放器', async () => {
    const firstDescriptor = deferred<MediaDescriptor>();
    const first = new TestWorker();
    first.describe.mockImplementation(() => firstDescriptor.promise);
    first.close.mockImplementation(async () => {
      firstDescriptor.reject(new Error('closed'));
    });
    const second = new TestWorker();
    const workers = [first, second];
    const nativePlan: PlaybackPlan = {
      strategy: 'native',
      path: 'native-file',
      configurationKey: 'native-configuration',
      mediaFingerprint: 'fingerprint-a',
      videoTrackId: 'video-2',
      audioTrackId: 'audio-4',
    };
    const planning: PlanningResult = { status: 'ready', plan: nativePlan, evidence: [] };
    const runtime = new BrowserPlaybackRuntime({
      capabilities: {
        plan: vi.fn(async () => planning),
        recordSample: vi.fn(async () => undefined),
      },
      createWorker: () => workers.shift() as TestWorker,
    });
    const firstMedia = new TestMediaElement();
    const secondMedia = new TestMediaElement();

    const stale = runtime.start({
      source: directSource('source-a', 'https://cdn.example/first', true),
      mediaElement: firstMedia as unknown as HTMLMediaElement,
    });
    await flush();
    const current = runtime.start({
      source: directSource('source-b', 'https://cdn.example/second', true),
      mediaElement: secondMedia as unknown as HTMLMediaElement,
    });

    await expect(stale).rejects.toBeInstanceOf(BrowserPlaybackSupersededError);
    await expect(current).resolves.toMatchObject({ plan: nativePlan });
    expect(firstMedia.play).not.toHaveBeenCalled();
    expect(secondMedia.play).toHaveBeenCalledOnce();
    await runtime.stop();
  });
});

const directSource = (sourceId: string, url: string, native = false): MediaSourceDescriptor => ({
  sourceId,
  access: { kind: 'direct-http-range', url },
  ...(native ? { nativePlaybackUrl: url } : {}),
});

const stream = (): MediaWorkerStream => ({
  mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
  timelineOffsetSeconds: 0,
  initialPositionSeconds: 0,
  completion: new Promise<void>(() => undefined),
  read: async () => undefined,
  cancel: async () => undefined,
});

const deferred = <T>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const ranges = (values: Array<[number, number]>): TimeRanges => ({
  length: values.length,
  start: (index) => values[index]?.[0] ?? 0,
  end: (index) => values[index]?.[1] ?? 0,
});
