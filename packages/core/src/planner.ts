import type {
  AudioConfiguration,
  CapabilityEvidence,
  CapabilityProbeRequest,
  CapabilitySnapshot,
  ExactMediaConfiguration,
  MediaCapabilitiesProbeConfiguration,
  MediaTrack,
  PlanningResult,
  PlaybackIntent,
  PlaybackPath,
  PlaybackPlan,
  SampleCapabilityEvidence,
  VideoConfiguration,
  VideoMediaTrack,
} from '@shimweave/contracts';
import { createConfigurationKey, createMediaFingerprint } from './capability-identity.js';

type CandidatePath = Exclude<PlaybackPath, 'webcodecs-video'>;

interface Candidate {
  plan: PlaybackPlan;
  configuration: ExactMediaConfiguration;
  contentType: string;
}

type CandidateEvaluation =
  | { status: 'ready'; evidence: readonly string[] }
  | { status: 'probe-required'; probes: readonly CapabilityProbeRequest[] }
  | { status: 'rejected'; reason: string; evidence: readonly string[] };

const chooseTrack = <Track extends MediaTrack>(tracks: readonly Track[]): Track | undefined =>
  tracks.find((track) => track.isDefault) ?? tracks[0];

/**
 * 规划器只依据媒体事实和当前运行时证据选择路径。证据跨路径、跨配置或跨源复用均视为未命中。
 */
export const planPlayback = (
  intent: PlaybackIntent,
  capabilities: CapabilitySnapshot,
): PlanningResult => {
  const videos = intent.media.tracks.filter(
    (track): track is VideoMediaTrack => track.kind === 'video',
  );
  const audios = intent.media.tracks.filter((track) => track.kind === 'audio');
  const subtitles = intent.media.tracks.filter((track) => track.kind === 'subtitle');
  const video = videos[0];
  const audio = intent.preferredAudioTrackId
    ? audios.find((track) => track.id === intent.preferredAudioTrackId)
    : chooseTrack(audios);
  const subtitle = intent.preferredSubtitleTrackId
    ? subtitles.find((track) => track.id === intent.preferredSubtitleTrackId)
    : undefined;

  if (!video) return { status: 'unsupported', reason: 'missing_video_track', evidence: [] };
  if (intent.preferredAudioTrackId && !audio) {
    return { status: 'unsupported', reason: 'preferred_audio_track_unavailable', evidence: [] };
  }
  if (intent.preferredSubtitleTrackId && !subtitle) {
    return { status: 'unsupported', reason: 'preferred_subtitle_track_unavailable', evidence: [] };
  }
  if (subtitle) {
    return { status: 'unsupported', reason: 'subtitle_playback_unavailable', evidence: [] };
  }
  const missingFacts = findMissingFacts(video);
  if (missingFacts.length > 0) {
    return { status: 'probe-required', probes: [{ kind: 'media-facts', fields: missingFacts }] };
  }

  const mediaFingerprint = createMediaFingerprint(intent.media);
  const candidates = createCandidates(
    intent,
    capabilities,
    video as CompleteVideoTrack,
    audio,
    mediaFingerprint,
  );
  if (candidates.length === 0) {
    return { status: 'unsupported', reason: 'no_playback_path', evidence: [] };
  }

  const rejected: string[] = [];
  for (const candidate of candidates) {
    const evaluation = evaluateCandidate(candidate, capabilities, mediaFingerprint);
    if (evaluation.status === 'ready') {
      return { status: 'ready', plan: candidate.plan, evidence: evaluation.evidence };
    }
    if (evaluation.status === 'probe-required') {
      return {
        status: 'probe-required',
        candidate: candidate.plan,
        probes: evaluation.probes,
      };
    }
    rejected.push(...evaluation.evidence, evaluation.reason);
  }
  return { status: 'unsupported', reason: 'no_supported_playback_path', evidence: rejected };
};

type CompleteVideoTrack = VideoMediaTrack & {
  codecString: string;
  codedWidth: number;
  codedHeight: number;
};

type CompleteAudioTrack = Extract<MediaTrack, { kind: 'audio' }> & { codecString: string };
type AudioTrack = Extract<MediaTrack, { kind: 'audio' }>;

type MissingMediaFact = Extract<CapabilityProbeRequest, { kind: 'media-facts' }>['fields'][number];

const findMissingFacts = (video: VideoMediaTrack): MissingMediaFact[] => {
  const missing: MissingMediaFact[] = [];
  if (!video.codecString) missing.push('video-codec-string');
  if (!positiveInteger(video.codedWidth) || !positiveInteger(video.codedHeight)) {
    missing.push('video-dimensions');
  }
  return missing;
};

const createCandidates = (
  intent: PlaybackIntent,
  capabilities: CapabilitySnapshot,
  video: CompleteVideoTrack,
  audio: AudioTrack | undefined,
  mediaFingerprint: string,
): Candidate[] => {
  const candidates: Candidate[] = [];
  const originalAudio = hasCodecString(audio) ? audio : undefined;
  const canKeepOriginalAudio = audio === undefined || originalAudio !== undefined;
  if (
    canKeepOriginalAudio &&
    intent.nativeSourceUrlAvailable !== false &&
    !intent.preferredAudioTrackId &&
    intent.media.mimeType
  ) {
    candidates.push(
      createCandidate(
        capabilities,
        'native-file',
        'native',
        intent.media.container,
        intent.media.mimeType,
        video,
        originalAudio,
        mediaFingerprint,
      ),
    );
  }

  if (!capabilities.remuxContainers.includes('mp4')) return candidates;
  if (canKeepOriginalAudio) {
    candidates.push(
      createCandidate(
        capabilities,
        'mse-remux',
        'remux',
        'mp4',
        'video/mp4',
        video,
        originalAudio,
        mediaFingerprint,
      ),
    );
  }

  if (audio) {
    const transform = capabilities.transforms.find(
      (candidate) =>
        candidate.kind === 'audio' &&
        candidate.from === audio.codec &&
        candidate.outputAudio !== undefined &&
        candidate.to === candidate.outputAudio.codec,
    );
    if (transform?.outputAudio) {
      const outputAudio = {
        id: audio.id,
        kind: 'audio' as const,
        codec: transform.outputAudio.codec,
        codecString: transform.outputAudio.codecString,
        channels: transform.outputAudio.channels,
        ...(transform.outputAudio.channelLayout
          ? { channelLayout: transform.outputAudio.channelLayout }
          : {}),
        sampleRate: transform.outputAudio.sampleRate,
        bitrate: transform.outputAudio.bitrate,
      };
      candidates.push(
        createCandidate(
          capabilities,
          'mse-remux-audio-transcode',
          'remux-audio-transcode',
          'mp4',
          'video/mp4',
          video,
          outputAudio,
          mediaFingerprint,
          transform.outputAudio,
        ),
      );
    }
  }
  return candidates;
};

const hasCodecString = (track: AudioTrack | undefined): track is CompleteAudioTrack =>
  Boolean(track?.codecString);

const createCandidate = (
  capabilities: CapabilitySnapshot,
  path: CandidatePath,
  strategy: PlaybackPlan['strategy'],
  container: string,
  mimeType: string,
  videoTrack: CompleteVideoTrack,
  audioTrack: CompleteAudioTrack | undefined,
  mediaFingerprint: string,
  outputAudio?: PlaybackPlan['outputAudio'],
): Candidate => {
  const video = toVideoConfiguration(videoTrack);
  const audio = audioTrack ? toAudioConfiguration(audioTrack) : undefined;
  const configuration: ExactMediaConfiguration = {
    container,
    mimeType,
    video,
    ...(audio ? { audio } : {}),
  };
  const configurationKey = createConfigurationKey(
    capabilities.scope.schemaVersion,
    path,
    configuration,
  );
  return {
    configuration,
    contentType: createContentType(mimeType, video.codecString, audio?.codecString),
    plan: {
      strategy,
      path,
      configurationKey,
      mediaFingerprint,
      ...(strategy === 'native' ? {} : { outputContainer: container }),
      videoTrackId: videoTrack.id,
      ...(audioTrack ? { audioTrackId: audioTrack.id } : {}),
      ...(outputAudio ? { outputAudio } : {}),
    },
  };
};

const evaluateCandidate = (
  candidate: Candidate,
  capabilities: CapabilitySnapshot,
  mediaFingerprint: string,
): CandidateEvaluation => {
  const evidence = capabilities.evidence.filter(
    (item) =>
      item.path === candidate.plan.path &&
      item.configurationKey === candidate.plan.configurationKey,
  );
  const sample = latestDeterministicSample(evidence, mediaFingerprint);
  if (sample?.support === 'supported') {
    return { status: 'ready', evidence: [`sample:${sample.milestone}`] };
  }
  if (sample?.support === 'unsupported') {
    return {
      status: 'rejected',
      reason: `sample_${sample.failureClass}`,
      evidence: [`sample:${sample.failureClass}`],
    };
  }

  if (candidate.plan.path === 'native-file') {
    return evaluateNativeCandidate(candidate, evidence, mediaFingerprint);
  }
  return evaluateMseCandidate(candidate, evidence, mediaFingerprint);
};

const evaluateNativeCandidate = (
  candidate: Candidate,
  evidence: readonly CapabilityEvidence[],
  mediaFingerprint: string,
): CandidateEvaluation => {
  const mediaCapabilities = latestEvidence(evidence, 'media-capabilities');
  if (!mediaCapabilities) {
    const configuration = toMediaCapabilitiesConfiguration(candidate, 'file');
    return {
      status: 'probe-required',
      probes: configuration
        ? [
            {
              kind: 'media-capabilities',
              path: 'native-file',
              configurationKey: candidate.plan.configurationKey,
              configuration,
            },
          ]
        : [sampleProbe(candidate, mediaFingerprint)],
    };
  }
  if (mediaCapabilities.support === 'supported') {
    return {
      status: 'ready',
      evidence: [
        `media-capabilities:supported:${qualityLabel(mediaCapabilities.smooth, mediaCapabilities.powerEfficient)}`,
      ],
    };
  }
  if (mediaCapabilities.support === 'unknown') {
    return { status: 'probe-required', probes: [sampleProbe(candidate, mediaFingerprint)] };
  }
  return {
    status: 'rejected',
    reason: 'native_configuration_not_supported',
    evidence: ['media-capabilities:unsupported'],
  };
};

const evaluateMseCandidate = (
  candidate: Candidate,
  evidence: readonly CapabilityEvidence[],
  mediaFingerprint: string,
): CandidateEvaluation => {
  const msePath = candidate.plan.path;
  if (msePath === 'native-file') {
    throw new TypeError('MSE evaluation requires an MSE playback path');
  }
  const mse = latestEvidence(evidence, 'mse-type');
  if (!mse) {
    return {
      status: 'probe-required',
      probes: [
        {
          kind: 'mse-type',
          path: msePath,
          configurationKey: candidate.plan.configurationKey,
          contentType: candidate.contentType,
        },
      ],
    };
  }
  if (mse.support === 'unsupported') {
    return {
      status: 'rejected',
      reason: 'mse_configuration_not_supported',
      evidence: ['mse-type:unsupported'],
    };
  }
  if (mse.support === 'unknown') {
    return { status: 'probe-required', probes: [sampleProbe(candidate, mediaFingerprint)] };
  }

  const mediaCapabilities = latestEvidence(evidence, 'media-capabilities');
  if (!mediaCapabilities) {
    const configuration = toMediaCapabilitiesConfiguration(candidate, 'media-source');
    if (configuration) {
      return {
        status: 'probe-required',
        probes: [
          {
            kind: 'media-capabilities',
            path: msePath,
            configurationKey: candidate.plan.configurationKey,
            configuration,
          },
        ],
      };
    }
    return { status: 'ready', evidence: ['mse-type:supported'] };
  }
  if (mediaCapabilities.support === 'unsupported') {
    return { status: 'probe-required', probes: [sampleProbe(candidate, mediaFingerprint)] };
  }
  return {
    status: 'ready',
    evidence: [
      'mse-type:supported',
      `media-capabilities:${mediaCapabilities.support}:${qualityLabel(
        mediaCapabilities.smooth,
        mediaCapabilities.powerEfficient,
      )}`,
    ],
  };
};

const sampleProbe = (
  candidate: Candidate,
  mediaFingerprint: string,
): Extract<CapabilityProbeRequest, { kind: 'sample-playback' }> => ({
  kind: 'sample-playback',
  path: candidate.plan.path,
  configurationKey: candidate.plan.configurationKey,
  mediaFingerprint,
});

const latestDeterministicSample = (
  evidence: readonly CapabilityEvidence[],
  mediaFingerprint: string,
): SampleCapabilityEvidence | undefined =>
  evidence
    .filter(
      (item): item is SampleCapabilityEvidence =>
        item.kind === 'sample' &&
        item.mediaFingerprint === mediaFingerprint &&
        item.support !== 'unknown',
    )
    .sort((left, right) => right.observedAt - left.observedAt)[0];

const latestEvidence = <Kind extends CapabilityEvidence['kind']>(
  evidence: readonly CapabilityEvidence[],
  kind: Kind,
): Extract<CapabilityEvidence, { kind: Kind }> | undefined =>
  evidence
    .filter((item): item is Extract<CapabilityEvidence, { kind: Kind }> => item.kind === kind)
    .sort((left, right) => right.observedAt - left.observedAt)[0];

const toVideoConfiguration = (track: CompleteVideoTrack): VideoConfiguration => ({
  codec: track.codec,
  codecString: track.codecString,
  codedWidth: track.codedWidth,
  codedHeight: track.codedHeight,
  ...(track.profile ? { profile: track.profile } : {}),
  ...(track.level ? { level: track.level } : {}),
  ...(track.tier ? { tier: track.tier } : {}),
  ...(track.bitDepth !== undefined ? { bitDepth: track.bitDepth } : {}),
  ...(track.chromaSubsampling ? { chromaSubsampling: track.chromaSubsampling } : {}),
  ...(track.displayWidth !== undefined ? { displayWidth: track.displayWidth } : {}),
  ...(track.displayHeight !== undefined ? { displayHeight: track.displayHeight } : {}),
  ...(track.frameRate ? { frameRate: track.frameRate } : {}),
  ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
  ...(track.colorSpace ? { colorSpace: track.colorSpace } : {}),
  ...(track.hdr ? { hdr: track.hdr } : {}),
  ...(track.decoderDescriptionHash ? { decoderDescriptionHash: track.decoderDescriptionHash } : {}),
});

const toAudioConfiguration = (track: CompleteAudioTrack): AudioConfiguration => ({
  codec: track.codec,
  codecString: track.codecString,
  ...(track.profile ? { profile: track.profile } : {}),
  ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
  ...(track.channels !== undefined ? { channels: track.channels } : {}),
  ...(track.channelLayout ? { channelLayout: track.channelLayout } : {}),
  ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
  ...(track.bitDepth !== undefined ? { bitDepth: track.bitDepth } : {}),
});

const createContentType = (
  mimeType: string,
  videoCodecString: string,
  audioCodecString: string | undefined,
): string => {
  const codecs = audioCodecString ? `${videoCodecString}, ${audioCodecString}` : videoCodecString;
  return `${mimeType}; codecs="${codecs}"`;
};

const toMediaCapabilitiesConfiguration = (
  candidate: Candidate,
  type: MediaCapabilitiesProbeConfiguration['type'],
): MediaCapabilitiesProbeConfiguration | undefined => {
  const { video, audio } = candidate.configuration;
  const frameRate = video.frameRate
    ? video.frameRate.numerator / video.frameRate.denominator
    : undefined;
  if (!positiveNumber(video.bitrate) || !positiveNumber(frameRate)) return undefined;
  const audioConfiguration =
    audio &&
    positiveInteger(audio.channels) &&
    positiveInteger(audio.sampleRate) &&
    positiveNumber(audio.bitrate)
      ? {
          contentType: `audio/mp4; codecs="${audio.codecString}"`,
          channels: String(audio.channels),
          bitrate: audio.bitrate,
          samplerate: audio.sampleRate,
        }
      : undefined;
  return {
    type,
    video: {
      contentType: candidate.contentType,
      width: video.codedWidth,
      height: video.codedHeight,
      bitrate: video.bitrate,
      framerate: frameRate,
    },
    ...(audioConfiguration ? { audio: audioConfiguration } : {}),
  };
};

const positiveInteger = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value > 0;

const positiveNumber = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

const qualityLabel = (smooth: boolean | undefined, powerEfficient: boolean | undefined): string =>
  `${smooth === undefined ? 'unknown' : smooth ? 'smooth' : 'not-smooth'}:${
    powerEfficient === undefined ? 'unknown' : powerEfficient ? 'efficient' : 'not-efficient'
  }`;
