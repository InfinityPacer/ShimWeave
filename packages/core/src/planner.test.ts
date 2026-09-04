import type {
  CapabilityEvidence,
  CapabilitySnapshot,
  ExactMediaConfiguration,
  PlanningResult,
  PlaybackIntent,
  PlaybackPlan,
} from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeCapabilityValue,
  createCapabilityCacheKey,
  createConfigurationKey,
  createSampleCacheKey,
} from './capability-identity.js';
import { planPlayback } from './planner.js';

const baseCapabilities = (evidence: readonly CapabilityEvidence[] = []): CapabilitySnapshot => ({
  scope: { schemaVersion: 1, runtimeKey: 'runtime-a', engineKey: 'engine-a' },
  evidence,
  remuxContainers: ['mp4'],
  transforms: [aacFallback('ac3'), aacFallback('eac3'), aacFallback('dts')],
});

const aacFallback = (from: string): CapabilitySnapshot['transforms'][number] => ({
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

const intent = (
  overrides: Partial<PlaybackIntent['media']> = {},
  video: Partial<Extract<PlaybackIntent['media']['tracks'][number], { kind: 'video' }>> = {},
  audio: Partial<Extract<PlaybackIntent['media']['tracks'][number], { kind: 'audio' }>> | null = {},
): PlaybackIntent => ({
  media: {
    sourceId: 'stable-source',
    sourceFingerprint: 'etag-a',
    sizeBytes: 1000,
    container: 'matroska',
    tracks: [
      {
        id: 'video-1',
        kind: 'video',
        codec: 'hevc',
        codecString: 'hvc1.2.4.L153.B0',
        profile: 'main-10',
        level: '5.1',
        bitDepth: 10,
        codedWidth: 3840,
        codedHeight: 2160,
        ...video,
      },
      ...(audio === null
        ? []
        : [
            {
              id: 'audio-1',
              kind: 'audio' as const,
              codec: 'aac',
              codecString: 'mp4a.40.2',
              channels: 2,
              sampleRate: 48000,
              ...audio,
            },
          ]),
    ],
    ...overrides,
  },
});

const expectProbe = (
  result: PlanningResult,
  kind: Extract<PlanningResult, { status: 'probe-required' }>['probes'][number]['kind'],
): Extract<PlanningResult, { status: 'probe-required' }> => {
  expect(result.status).toBe('probe-required');
  if (result.status !== 'probe-required') throw new Error('Expected probe-required result');
  expect(result.probes[0]?.kind).toBe(kind);
  return result;
};

const candidateFrom = (result: PlanningResult): PlaybackPlan => {
  expect(result.status).toBe('probe-required');
  if (result.status !== 'probe-required' || !result.candidate) {
    throw new Error('Expected a candidate plan');
  }
  return result.candidate;
};

type EvidenceInput<E> = E extends CapabilityEvidence
  ? Omit<E, 'path' | 'configurationKey' | 'observedAt'>
  : never;

const evidenceFor = (
  plan: PlaybackPlan,
  evidence: EvidenceInput<CapabilityEvidence>,
  observedAt = 1,
): CapabilityEvidence =>
  ({
    ...evidence,
    path: plan.path,
    configurationKey: plan.configurationKey,
    observedAt,
  }) as CapabilityEvidence;

describe('capability identity', () => {
  const configuration = (video: ExactMediaConfiguration['video']): ExactMediaConfiguration => ({
    container: 'mp4',
    mimeType: 'video/mp4',
    video,
  });

  it('对象字段顺序不改变确定性身份', () => {
    expect(canonicalizeCapabilityValue({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalizeCapabilityValue({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('区分 HEVC profile、分辨率、帧率和动态范围', () => {
    const base = {
      codec: 'hevc',
      codecString: 'hvc1.1.6.L120.B0',
      codedWidth: 1920,
      codedHeight: 1080,
      frameRate: { numerator: 24, denominator: 1 },
      hdr: { kind: 'sdr' as const },
    };
    const keys = [
      configuration(base),
      configuration({ ...base, codecString: 'hvc1.2.4.L153.B0', profile: 'main-10' }),
      configuration({ ...base, codedWidth: 3840, codedHeight: 2160 }),
      configuration({ ...base, frameRate: { numerator: 60, denominator: 1 } }),
      configuration({ ...base, hdr: { kind: 'hdr10' } }),
      configuration({ ...base, hdr: { kind: 'hlg' } }),
      configuration({ ...base, hdr: { kind: 'dolby-vision', profile: 5 } }),
      configuration({
        ...base,
        hdr: { kind: 'dolby-vision', profile: 8, compatibilityId: 1, hasHdr10BaseLayer: true },
      }),
    ].map((item) => createConfigurationKey(1, 'mse-remux', item));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('运行时、引擎和源指纹变化都会使缓存身份失效', () => {
    const configurationKey = createConfigurationKey(
      1,
      'mse-remux',
      configuration({
        codec: 'h264',
        codecString: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
      }),
    );
    const scope = { schemaVersion: 1, runtimeKey: 'runtime-a', engineKey: 'engine-a' };
    expect(createCapabilityCacheKey(scope, configurationKey)).not.toBe(
      createCapabilityCacheKey({ ...scope, runtimeKey: 'runtime-b' }, configurationKey),
    );
    expect(createCapabilityCacheKey(scope, configurationKey)).not.toBe(
      createCapabilityCacheKey({ ...scope, engineKey: 'engine-b' }, configurationKey),
    );
    expect(createSampleCacheKey(scope, configurationKey, 'source-a')).not.toBe(
      createSampleCacheKey(scope, configurationKey, 'source-b'),
    );
  });
});

describe('planPlayback', () => {
  it('关键媒体事实缺失时先请求事实探测', () => {
    const incomplete = intent();
    const video = incomplete.media.tracks.find((track) => track.kind === 'video');
    const audio = incomplete.media.tracks.find((track) => track.kind === 'audio');
    if (!video || !audio) throw new Error('Expected media tracks');
    delete video.codecString;
    delete video.codedWidth;
    delete audio.codecString;
    const result = planPlayback(incomplete, baseCapabilities());
    expect(expectProbe(result, 'media-facts').probes[0]).toEqual({
      kind: 'media-facts',
      fields: ['video-codec-string', 'video-dimensions'],
    });
  });

  it('无参数串且没有转换路径的音频直接判定无播放路径', () => {
    const media = intent({}, {}, { codec: 'a_truehd' });
    const audio = media.media.tracks.find((track) => track.kind === 'audio');
    if (!audio) throw new Error('Expected audio track');
    delete audio.codecString;
    media.nativeSourceUrlAvailable = false;

    expect(planPlayback(media, baseCapabilities())).toEqual({
      status: 'unsupported',
      reason: 'no_playback_path',
      evidence: [],
    });
  });

  it('可转换音频缺少参数串时仍可使用明确的输出配置', () => {
    const media = intent({}, {}, { codec: 'dts' });
    const audio = media.media.tracks.find((track) => track.kind === 'audio');
    if (!audio) throw new Error('Expected audio track');
    delete audio.codecString;
    media.nativeSourceUrlAvailable = false;

    expect(
      expectProbe(planPlayback(media, baseCapabilities()), 'mse-type').candidate,
    ).toMatchObject({
      strategy: 'remux-audio-transcode',
      path: 'mse-remux-audio-transcode',
      outputAudio: { codec: 'aac', codecString: 'mp4a.40.2' },
    });
  });

  it('完整原生配置先通过 MediaCapabilities 验证', () => {
    const media = intent(
      { container: 'mp4', mimeType: 'video/mp4' },
      { bitrate: 12_000_000, frameRate: { numerator: 24, denominator: 1 } },
      { bitrate: 192_000 },
    );
    const first = planPlayback(media, baseCapabilities());
    const plan = candidateFrom(first);
    expect(plan).toMatchObject({ strategy: 'native', path: 'native-file' });
    expect(expectProbe(first, 'media-capabilities').probes[0]).toMatchObject({
      kind: 'media-capabilities',
      configuration: { type: 'file' },
    });

    const supported = evidenceFor(plan, {
      kind: 'media-capabilities',
      support: 'supported',
      smooth: true,
      powerEfficient: true,
    });
    expect(planPlayback(media, baseCapabilities([supported]))).toMatchObject({
      status: 'ready',
      plan: { strategy: 'native' },
    });
  });

  it('控制端点不能交给原生媒体元素，直接从 MSE 路径开始规划', () => {
    const media = intent({ container: 'mp4', mimeType: 'video/mp4' });
    media.nativeSourceUrlAvailable = false;

    const result = expectProbe(planPlayback(media, baseCapabilities()), 'mse-type');

    expect(result.candidate).toMatchObject({ strategy: 'remux', path: 'mse-remux' });
  });

  it('原生配置不支持后再检查 MSE 转封装', () => {
    const media = intent({ mimeType: 'video/x-matroska' });
    const native = candidateFrom(planPlayback(media, baseCapabilities()));
    const nativeUnsupported = evidenceFor(native, {
      kind: 'media-capabilities',
      support: 'unsupported',
    });
    const remux = expectProbe(
      planPlayback(media, baseCapabilities([nativeUnsupported])),
      'mse-type',
    );
    expect(remux.candidate).toMatchObject({ strategy: 'remux', path: 'mse-remux' });
  });

  it('WebCodecs 否定证据不会误杀 MSE 原码转封装路径', () => {
    const media = intent();
    const first = planPlayback(media, baseCapabilities());
    const remux = candidateFrom(first);
    const mseSupported = evidenceFor(remux, {
      kind: 'mse-type',
      support: 'supported',
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
    });
    const unrelatedDecoderEvidence: CapabilityEvidence = {
      kind: 'video-decoder',
      path: 'webcodecs-video',
      configurationKey: remux.configurationKey,
      support: 'unsupported',
      observedAt: 2,
    };

    expect(planPlayback(media, baseCapabilities([mseSupported, unrelatedDecoderEvidence]))).toEqual(
      {
        status: 'ready',
        plan: remux,
        evidence: ['mse-type:supported'],
      },
    );
  });

  it('MSE 与 MediaCapabilities 冲突时要求真实样本而不直接否决', () => {
    const media = intent(
      {},
      { bitrate: 12_000_000, frameRate: { numerator: 24, denominator: 1 } },
      { bitrate: 192_000 },
    );
    const remux = candidateFrom(planPlayback(media, baseCapabilities()));
    const mseSupported = evidenceFor(remux, {
      kind: 'mse-type',
      support: 'supported',
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"',
    });
    const mediaCapabilitiesUnsupported = evidenceFor(remux, {
      kind: 'media-capabilities',
      support: 'unsupported',
    });
    const result = expectProbe(
      planPlayback(media, baseCapabilities([mseSupported, mediaCapabilitiesUnsupported])),
      'sample-playback',
    );
    expect(result.probes[0]).toMatchObject({ mediaFingerprint: remux.mediaFingerprint });
  });

  it('同源真实样本覆盖 API 猜测，其他源不能复用该结果', () => {
    const media = intent();
    const remux = candidateFrom(planPlayback(media, baseCapabilities()));
    const sampleSupported = evidenceFor(remux, {
      kind: 'sample',
      mediaFingerprint: remux.mediaFingerprint,
      support: 'supported',
      milestone: 'steady-playback',
    });
    expect(planPlayback(media, baseCapabilities([sampleSupported]))).toMatchObject({
      status: 'ready',
      evidence: ['sample:steady-playback'],
    });

    const otherSource = intent({ sourceId: 'other-source' });
    expect(expectProbe(planPlayback(otherSource, baseCapabilities([sampleSupported])), 'mse-type'));
  });

  it('确定性格式失败会否决候选，网络和取消错误不会污染能力结论', () => {
    const media = intent();
    const remux = candidateFrom(planPlayback(media, baseCapabilities()));
    const formatFailure = evidenceFor(remux, {
      kind: 'sample',
      mediaFingerprint: remux.mediaFingerprint,
      support: 'unsupported',
      failureClass: 'decode',
    });
    expect(planPlayback(media, baseCapabilities([formatFailure]))).toMatchObject({
      status: 'unsupported',
      reason: 'no_supported_playback_path',
    });

    const networkFailure = evidenceFor(remux, {
      kind: 'sample',
      mediaFingerprint: remux.mediaFingerprint,
      support: 'unknown',
      failureClass: 'network',
    });
    expect(expectProbe(planPlayback(media, baseCapabilities([networkFailure])), 'mse-type'));
  });

  it('音频不兼容时只在原始 MSE 路径失败后选择音频转换', () => {
    const media = intent(
      {},
      {},
      {
        codec: 'eac3',
        codecString: 'ec-3',
        channels: 6,
        sampleRate: 96_000,
        bitrate: 640_000,
      },
    );
    const original = candidateFrom(planPlayback(media, baseCapabilities()));
    const originalUnsupported = evidenceFor(original, {
      kind: 'mse-type',
      support: 'unsupported',
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0, ec-3"',
    });
    const transcodeResult = expectProbe(
      planPlayback(media, baseCapabilities([originalUnsupported])),
      'mse-type',
    );
    expect(transcodeResult.candidate).toMatchObject({
      strategy: 'remux-audio-transcode',
      path: 'mse-remux-audio-transcode',
      outputAudio: {
        codec: 'aac',
        codecString: 'mp4a.40.2',
        channels: 2,
        channelLayout: 'stereo',
        sampleRate: 48_000,
        bitrate: 192_000,
      },
    });
  });

  it('未指定轨道时选择默认音轨并保持字幕关闭', () => {
    const media = intent();
    media.media.tracks = [
      ...media.media.tracks,
      {
        id: 'audio-default',
        kind: 'audio',
        codec: 'aac',
        codecString: 'mp4a.40.2',
        isDefault: true,
      },
      {
        id: 'subtitle-first',
        kind: 'subtitle',
        codec: 'srt',
        isDefault: true,
      },
    ];

    const planned = candidateFrom(planPlayback(media, baseCapabilities()));

    expect(planned.audioTrackId).toBe('audio-default');
    expect(planned.subtitleTrackId).toBeUndefined();
  });

  it('明确音轨不存在时不静默回退默认轨', () => {
    const media = intent();
    media.preferredAudioTrackId = 'plex-stream-id';

    expect(planPlayback(media, baseCapabilities())).toEqual({
      status: 'unsupported',
      reason: 'preferred_audio_track_unavailable',
      evidence: [],
    });
  });

  it('明确选择音轨时跳过无法控制内嵌音轨的原生路径', () => {
    const media = intent();
    media.preferredAudioTrackId = 'audio-1';

    const planned = candidateFrom(planPlayback(media, baseCapabilities()));

    expect(planned.path).toBe('mse-remux');
    expect(planned.audioTrackId).toBe('audio-1');
  });

  it('字幕轨道未实现时明确拒绝而不生成无效计划', () => {
    const media = intent();
    media.media.tracks = [
      ...media.media.tracks,
      {
        id: 'subtitle-selected',
        kind: 'subtitle',
        codec: 'srt',
      },
    ];
    media.preferredSubtitleTrackId = 'subtitle-selected';

    expect(planPlayback(media, baseCapabilities())).toEqual({
      status: 'unsupported',
      reason: 'subtitle_playback_unavailable',
      evidence: [],
    });

    media.preferredSubtitleTrackId = 'plex-subtitle-id';
    expect(planPlayback(media, baseCapabilities())).toEqual({
      status: 'unsupported',
      reason: 'preferred_subtitle_track_unavailable',
      evidence: [],
    });
  });

  it('没有视频轨或可执行路径时返回明确不支持', () => {
    const audioOnly = intent({}, {}, { codec: 'aac' });
    audioOnly.media.tracks = audioOnly.media.tracks.filter((track) => track.kind === 'audio');
    expect(planPlayback(audioOnly, baseCapabilities())).toEqual({
      status: 'unsupported',
      reason: 'missing_video_track',
      evidence: [],
    });

    expect(
      planPlayback(intent(), {
        ...baseCapabilities(),
        remuxContainers: [],
      }),
    ).toEqual({ status: 'unsupported', reason: 'no_playback_path', evidence: [] });
  });
});
