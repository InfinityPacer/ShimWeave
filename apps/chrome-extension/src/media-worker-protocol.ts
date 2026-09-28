import type {
  AudioTranscodeOutput,
  MediaDescriptor,
  MediaSourceDescriptor,
  SubtitleCue,
  SubtitleUnavailableReason,
} from '@shimweave/contracts';
import type { RangeLeasePort } from '@shimweave/core';

export const MEDIA_WORKER_PROTOCOL = 'shimweave-media-worker-v1' as const;

export interface MediaWorkerInitMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'init';
  sessionId: string;
  /** 短期地址和控制头只进入 Dedicated Worker，不得出现在状态、日志或错误响应中。 */
  source: MediaSourceDescriptor;
  coordinatorPort?: RangeLeasePort;
}

export interface MediaWorkerDescribeMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'describe';
  requestId: string;
}

export interface MediaWorkerStartStreamMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'start-stream';
  requestId: string;
  outputAudio?: AudioTranscodeOutput;
  videoTrackId?: string;
  audioTrackId?: string;
  /** 与本次视频流同代读取的内嵌字幕；字幕失败只回报 subtitle-unavailable，不结束视频流。 */
  subtitleTrackId?: string;
  startSeconds?: number;
}

export interface MediaWorkerAppendAckMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'append-ack';
  requestId: string;
  chunkId: string;
}

export interface MediaWorkerCancelStreamMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'cancel-stream';
  requestId: string;
}

export interface MediaWorkerCloseMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'close';
}

export type MediaWorkerClientMessage =
  | MediaWorkerInitMessage
  | MediaWorkerDescribeMessage
  | MediaWorkerStartStreamMessage
  | MediaWorkerAppendAckMessage
  | MediaWorkerCancelStreamMessage
  | MediaWorkerCloseMessage;

export interface MediaWorkerReadyMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'ready';
  sessionId: string;
  schedulerMode: 'shared' | 'local';
}

export interface MediaWorkerDescriptorMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'descriptor';
  requestId: string;
  descriptor: MediaDescriptor;
}

export interface MediaWorkerStreamReadyMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'stream-ready';
  requestId: string;
  mimeType: string;
  /** 描述阶段得到的完整媒体时长；缺失时播放器保留浏览器推导的时长。 */
  durationSeconds?: number;
  timelineOffsetSeconds: number;
  initialPositionSeconds: number;
}

export interface MediaWorkerStreamChunkMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'stream-chunk';
  requestId: string;
  chunkId: string;
  bytes: ArrayBuffer;
}

export interface MediaWorkerStreamCompleteMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'stream-complete';
  requestId: string;
}

/** 字幕 cue 按簇批量回传，不占用媒体块的确认通道。 */
export interface MediaWorkerSubtitleCuesMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'subtitle-cues';
  requestId: string;
  cues: readonly SubtitleCue[];
}

export interface MediaWorkerSubtitleUnavailableMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'subtitle-unavailable';
  requestId: string;
  reason: SubtitleUnavailableReason;
}

export interface MediaWorkerErrorMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'error';
  requestId?: string;
  code:
    | 'invalid_request'
    | 'not_ready'
    | 'probe_failed'
    | 'initialization_failed'
    | 'stream_failed'
    | 'stream_active';
  message: string;
}

export interface MediaWorkerClosedMessage {
  protocol: typeof MEDIA_WORKER_PROTOCOL;
  type: 'closed';
}

export type MediaWorkerHostMessage =
  | MediaWorkerReadyMessage
  | MediaWorkerDescriptorMessage
  | MediaWorkerStreamReadyMessage
  | MediaWorkerStreamChunkMessage
  | MediaWorkerStreamCompleteMessage
  | MediaWorkerSubtitleCuesMessage
  | MediaWorkerSubtitleUnavailableMessage
  | MediaWorkerErrorMessage
  | MediaWorkerClosedMessage;
