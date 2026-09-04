export const PLAYER_FRAME_PROTOCOL = 'shimweave-player-frame-v1' as const;

export interface PlayerMediaSummary {
  container: string;
  durationSeconds: number | null;
  video: {
    codec: string;
    codecString: string | null;
    width: number | null;
    height: number | null;
    hdrKind: string | null;
    hdrProfile: number | null;
  };
  audio: {
    codec: string;
    codecString: string | null;
    channels: number | null;
  } | null;
}

export type PlayerFrameEvent =
  | { protocol: typeof PLAYER_FRAME_PROTOCOL; type: 'ready'; nonce: string }
  | {
      protocol: typeof PLAYER_FRAME_PROTOCOL;
      type: 'started';
      nonce: string;
      strategy: 'native' | 'remux' | 'remux-audio-transcode';
      media: PlayerMediaSummary;
    }
  | {
      protocol: typeof PLAYER_FRAME_PROTOCOL;
      type: 'playing' | 'paused' | 'ended';
      nonce: string;
      currentTime: number;
      duration: number | null;
    }
  | {
      protocol: typeof PLAYER_FRAME_PROTOCOL;
      type: 'time';
      nonce: string;
      currentTime: number;
      duration: number | null;
      paused: boolean;
      decodedVideoFrames?: number;
      decodedAudioBytes?: number;
    }
  | { protocol: typeof PLAYER_FRAME_PROTOCOL; type: 'error'; nonce: string; code: string };

export const isPlayerFrameEvent = (value: unknown, nonce: string): value is PlayerFrameEvent => {
  if (!isRecord(value) || value.protocol !== PLAYER_FRAME_PROTOCOL || value.nonce !== nonce) {
    return false;
  }
  if (value.type === 'ready') return true;
  if (value.type === 'playing' || value.type === 'paused' || value.type === 'ended') {
    return (
      finiteNonNegativeNumber(value.currentTime) &&
      (value.duration === null || finiteNonNegativeNumber(value.duration))
    );
  }
  if (value.type === 'started') {
    return playbackStrategy(value.strategy) && isPlayerMediaSummary(value.media);
  }
  if (value.type === 'time') {
    return (
      finiteNonNegativeNumber(value.currentTime) &&
      (value.duration === null || finiteNonNegativeNumber(value.duration)) &&
      typeof value.paused === 'boolean' &&
      optionalNonNegativeNumber(value.decodedVideoFrames) &&
      optionalNonNegativeNumber(value.decodedAudioBytes)
    );
  }
  return value.type === 'error' && nonEmptyString(value.code);
};

const playbackStrategy = (value: unknown): boolean =>
  value === 'native' || value === 'remux' || value === 'remux-audio-transcode';

const isPlayerMediaSummary = (value: unknown): value is PlayerMediaSummary => {
  if (!isRecord(value) || !nonEmptyString(value.container) || !isRecord(value.video)) return false;
  if (!nonEmptyString(value.video.codec)) return false;
  if (value.audio !== null && (!isRecord(value.audio) || !nonEmptyString(value.audio.codec))) {
    return false;
  }
  return true;
};

const finiteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const optionalNonNegativeNumber = (value: unknown): boolean =>
  value === undefined || finiteNonNegativeNumber(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
