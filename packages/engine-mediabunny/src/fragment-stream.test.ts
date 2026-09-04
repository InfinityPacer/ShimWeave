import type { Input, InputAudioTrack, InputVideoTrack } from 'mediabunny';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePacket {
  readonly timestamp: number;
  readonly label: string;
  clone(options: { timestamp: number }): FakePacket;
}

interface FakeTrack {
  readonly id: number;
  readonly codec: string;
  readonly packets: FakePacket[];
  readonly keyPacket?: FakePacket;
  readonly firstKeyPacket?: FakePacket;
  readonly keyPacketCalls: Array<{ startSeconds: number; options: unknown }>;
  readonly firstKeyPacketCalls: unknown[];
  getCodec(): Promise<string>;
  getDecoderConfig(): Promise<undefined>;
  getRotation(): Promise<number>;
  getLanguageCode(): Promise<string | undefined>;
  getDisposition(): Promise<undefined>;
  hasOnlyKeyPackets?(): Promise<boolean>;
}

interface FakeSourceRecord {
  readonly packets: FakePacket[];
  closed: boolean;
}

interface FakeOutputRecord {
  readonly videoTracks: Array<{ source: FakeSourceRecord; options: unknown }>;
  readonly audioTracks: Array<{ source: FakeSourceRecord; options: unknown }>;
  started: boolean;
  finalized: boolean;
  cancelled: boolean;
}

const mockState = vi.hoisted(() => ({
  outputRecords: [] as FakeOutputRecord[],
  videoSources: [] as FakeSourceRecord[],
  audioSources: [] as FakeSourceRecord[],
  audioAddGate: undefined as Promise<void> | undefined,
  conversionOptions: undefined as Record<string, unknown> | undefined,
  conversionExecuteStartedStates: [] as boolean[],
  conversionExecuteOptions: [] as unknown[],
}));

vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>();

  class FakeAppendOnlyStreamTarget {
    constructor(readonly stream: WritableStream<Uint8Array>) {}
  }

  class FakeMp4OutputFormat {
    constructor(readonly options: unknown) {}
  }

  class FakeEncodedVideoPacketSource {
    readonly record: FakeSourceRecord;

    constructor(readonly codec: string) {
      this.record = { packets: [], closed: false };
      mockState.videoSources.push(this.record);
    }

    async add(packet: FakePacket): Promise<void> {
      this.record.packets.push(packet);
    }

    close(): void {
      this.record.closed = true;
    }
  }

  class FakeEncodedAudioPacketSource {
    readonly record: FakeSourceRecord;

    constructor(readonly codec: string) {
      this.record = { packets: [], closed: false };
      mockState.audioSources.push(this.record);
    }

    async add(packet: FakePacket): Promise<void> {
      this.record.packets.push(packet);
      await mockState.audioAddGate;
    }

    close(): void {
      this.record.closed = true;
    }
  }

  class FakeEncodedPacketSink {
    constructor(private readonly track: FakeTrack) {}

    getKeyPacket(startSeconds: number, options: unknown): Promise<FakePacket | undefined> {
      this.track.keyPacketCalls.push({ startSeconds, options });
      return Promise.resolve(this.track.keyPacket);
    }

    getFirstKeyPacket(options: unknown): Promise<FakePacket | undefined> {
      this.track.firstKeyPacketCalls.push(options);
      return Promise.resolve(this.track.firstKeyPacket);
    }

    getFirstPacket(): Promise<FakePacket | undefined> {
      return Promise.resolve(this.track.packets[0]);
    }

    getPacket(startSeconds: number): Promise<FakePacket | undefined> {
      return Promise.resolve(
        this.track.packets.filter((packet) => packet.timestamp <= startSeconds).at(-1),
      );
    }

    getNextPacket(packet: FakePacket): Promise<FakePacket | undefined> {
      const index = this.track.packets.indexOf(packet);
      return Promise.resolve(this.track.packets[index + 1]);
    }

    async *packets(startPacket: FakePacket): AsyncIterable<FakePacket> {
      const index = this.track.packets.indexOf(startPacket);
      for (const packet of this.track.packets.slice(Math.max(index, 0))) yield packet;
    }
  }

  class FakeOutput {
    private readonly record: FakeOutputRecord = {
      videoTracks: [],
      audioTracks: [],
      started: false,
      finalized: false,
      cancelled: false,
    };

    constructor(readonly options: unknown) {
      mockState.outputRecords.push(this.record);
    }

    addVideoTrack(source: FakeEncodedVideoPacketSource, options: unknown): void {
      this.record.videoTracks.push({ source: source.record, options });
    }

    addAudioTrack(source: FakeEncodedAudioPacketSource, options: unknown): void {
      this.record.audioTracks.push({ source: source.record, options });
    }

    async start(): Promise<void> {
      this.record.started = true;
    }

    async getMimeType(): Promise<string> {
      return 'video/mp4; codecs="mock"';
    }

    async finalize(): Promise<void> {
      this.record.finalized = true;
    }

    async cancel(): Promise<void> {
      this.record.cancelled = true;
    }
  }

  class FakeConversion {
    readonly isValid = true;
    readonly discardedTracks = [];
    readonly utilizedTracks: FakeTrack[] = [];
    onProgress: ((progress: number, convertedSeconds: number) => unknown) | undefined;

    private constructor() {}

    static async init(options: Record<string, unknown>): Promise<FakeConversion> {
      mockState.conversionOptions = options;
      const conversion = new FakeConversion();
      const audio = options.audio;
      if (typeof audio === 'function') {
        const tracks = await (
          options.input as { getAudioTracks(): Promise<FakeTrack[]> }
        ).getAudioTracks();
        for (const track of tracks) {
          const trackOptions = await audio(track);
          if (!trackOptions?.discard) conversion.utilizedTracks.push(track);
        }
      }
      return conversion;
    }

    execute(options?: unknown): Promise<void> {
      mockState.conversionExecuteStartedStates.push(
        mockState.outputRecords.at(-1)?.started ?? false,
      );
      mockState.conversionExecuteOptions.push(options);
      this.onProgress?.(0.5, 2);
      return Promise.resolve();
    }

    cancel(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    ...actual,
    AppendOnlyStreamTarget: FakeAppendOnlyStreamTarget,
    Conversion: FakeConversion,
    EncodedAudioPacketSource: FakeEncodedAudioPacketSource,
    EncodedPacketSink: FakeEncodedPacketSink,
    EncodedVideoPacketSource: FakeEncodedVideoPacketSource,
    Mp4OutputFormat: FakeMp4OutputFormat,
    Output: FakeOutput,
  };
});

const {
  MediabunnyConversionUnsupportedError,
  MediabunnySeekOutOfRangeError,
  startMediaFragmentStream,
} = await import('./fragment-stream.js');

const outputAudio = {
  codec: 'aac' as const,
  codecString: 'mp4a.40.2',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
  bitrate: 192_000,
};

describe('Mediabunny fragment stream', () => {
  beforeEach(() => {
    mockState.outputRecords.length = 0;
    mockState.videoSources.length = 0;
    mockState.audioSources.length = 0;
    mockState.audioAddGate = undefined;
    mockState.conversionOptions = undefined;
    mockState.conversionExecuteStartedStates.length = 0;
    mockState.conversionExecuteOptions.length = 0;
  });

  it('非 Seek 转封装只保留规划器选中的音视频轨道', async () => {
    await startMediaFragmentStream(input(), sink(), {
      videoTrackId: '2',
      audioTrackId: '4',
      outputAudio,
    });

    const video = mockState.conversionOptions?.video as (track: { id: number }) => unknown;
    const audio = mockState.conversionOptions?.audio as (track: { id: number }) => unknown;
    expect(mockState.conversionOptions?.tracks).toBe('all');
    expect(video({ id: 2 })).toEqual({ forceTranscode: false });
    expect(video({ id: 3 })).toEqual({ discard: true });
    expect(audio({ id: 4 })).toEqual({
      codec: 'aac',
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      forceTranscode: true,
    });
    expect(audio({ id: 5 })).toEqual({ discard: true });
  });

  it('从目标前最近关键帧开始，并保持编码包顺序与重建时间轴', async () => {
    const keyPacket = packet(8, 'key');
    const video = track([keyPacket, packet(8.08, 'p'), packet(8.04, 'b')], keyPacket);
    const stream = await startMediaFragmentStream(input(video), sink(), { startSeconds: 10 });

    expect(stream.timelineOffsetSeconds).toBe(8);
    expect(stream.initialPositionSeconds).toBe(2);
    expect(video.keyPacketCalls).toEqual([
      { startSeconds: 10, options: { verifyKeyPackets: true } },
    ]);

    await stream.completion;
    expect(mockState.videoSources[0]?.packets.map((item) => item.timestamp)).toHaveLength(3);
    expect(mockState.videoSources[0]?.packets[0]?.timestamp).toBeCloseTo(0);
    expect(mockState.videoSources[0]?.packets[1]?.timestamp).toBeCloseTo(0.08);
    expect(mockState.videoSources[0]?.packets[2]?.timestamp).toBeCloseTo(0.04);
    expect(mockState.videoSources[0]?.packets.map((item) => item.label)).toEqual(['key', 'p', 'b']);
    expect(mockState.videoSources[0]?.closed).toBe(true);
    expect(mockState.outputRecords[0]?.finalized).toBe(true);
  });

  it('以视频关键帧为音画共同零点，保留音频相对起点', async () => {
    const videoStart = packet(8, 'video-key');
    const video = track([videoStart, packet(8.1, 'video')], videoStart);
    const audio = track([packet(8.04, 'audio')]);
    const stream = await startMediaFragmentStream(input(video, audio), sink(), {
      startSeconds: 10,
    });

    expect(stream.timelineOffsetSeconds).toBe(8);
    expect(stream.initialPositionSeconds).toBe(2);
    await stream.completion;

    expect(mockState.videoSources[0]?.packets).toHaveLength(2);
    expect(mockState.videoSources[0]?.packets[0]?.timestamp).toBeCloseTo(0);
    expect(mockState.videoSources[0]?.packets[1]?.timestamp).toBeCloseTo(0.1);
    expect(mockState.audioSources[0]?.packets).toHaveLength(1);
    expect(mockState.audioSources[0]?.packets[0]?.timestamp).toBeCloseTo(0.04);
    expect(mockState.audioSources[0]?.closed).toBe(true);
  });

  it('Seek 输出省略无效语言标记并保留 ISO 639-2/T 三字母代码', async () => {
    const videoStart = packet(8, 'video-key');
    const video = track([videoStart], videoStart, 2, 'zh');
    const audio = track([packet(8, 'audio')], undefined, 4, 'eng');
    const stream = await startMediaFragmentStream(input(video, audio), sink(), {
      startSeconds: 10,
    });

    expect(mockState.outputRecords[0]?.videoTracks[0]?.options).not.toHaveProperty('languageCode');
    expect(mockState.outputRecords[0]?.audioTracks[0]?.options).toMatchObject({
      languageCode: 'eng',
    });
    await stream.completion;
  });

  it('Seek 时仅转换选中的音频，并保持视频关键帧时间轴', async () => {
    const videoStart = packet(8, 'video-key');
    const video = track(
      [videoStart, packet(8.1, 'video'), packet(9.1, 'video-late')],
      videoStart,
      2,
    );
    const audio = track([packet(8.04, 'audio')], undefined, 4);
    const stream = await startMediaFragmentStream(input(video, audio), sink(), {
      startSeconds: 10,
      videoTrackId: '2',
      audioTrackId: '4',
      outputAudio,
    });

    expect(stream.timelineOffsetSeconds).toBe(8);
    expect(stream.initialPositionSeconds).toBe(2);
    expect(mockState.conversionOptions).toMatchObject({
      composable: true,
      tracks: 'all',
      trim: { start: 8 },
    });
    const audioOptions = mockState.conversionOptions?.audio as (track: FakeTrack) => unknown;
    expect(mockState.conversionOptions?.video).toEqual({ discard: true });
    expect(audioOptions(audio)).toMatchObject({
      codec: 'aac',
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      forceTranscode: true,
    });

    await stream.completion;
    expect(mockState.videoSources[0]?.packets.map((item) => item.label)).toEqual([
      'video-key',
      'video',
      'video-late',
    ]);
    expect(mockState.conversionExecuteStartedStates).toEqual([true]);
    expect(mockState.conversionExecuteOptions).toEqual([undefined]);
    expect(mockState.outputRecords[0]?.finalized).toBe(true);
  });

  it('慢音轨阻塞时限制视频轨领先量，并在慢轨结束后继续', async () => {
    let releaseAudio: () => void = () => undefined;
    mockState.audioAddGate = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const videoStart = packet(8, 'video-key');
    const video = track(
      [videoStart, packet(8.5, 'video-0.5'), packet(9.1, 'video-1.1'), packet(9.5, 'video-1.5')],
      videoStart,
    );
    const audio = track([packet(8, 'audio')]);
    const stream = await startMediaFragmentStream(input(video, audio), sink(), {
      startSeconds: 10,
    });

    await flush();
    expect(mockState.videoSources[0]?.packets.map((item) => item.label)).toEqual([
      'video-key',
      'video-0.5',
      'video-1.1',
    ]);

    releaseAudio();
    await stream.completion;
    expect(mockState.videoSources[0]?.packets.map((item) => item.label)).toEqual([
      'video-key',
      'video-0.5',
      'video-1.1',
      'video-1.5',
    ]);
    expect(mockState.outputRecords[0]?.finalized).toBe(true);
  });

  it('保留合法的负原始时间轴偏移，并将播放器定位值限制为非负', async () => {
    const keyPacket = packet(-0.5, 'negative-pts-key');
    const video = track([keyPacket, packet(0, 'video')], keyPacket);
    const stream = await startMediaFragmentStream(input(video), sink(), { startSeconds: 2 });

    expect(stream.timelineOffsetSeconds).toBe(-0.5);
    expect(stream.initialPositionSeconds).toBe(2.5);
    await stream.completion;
  });

  it('Seek 使用规划器选择的轨道，并拒绝不存在的轨道 ID', async () => {
    const ignoredKey = packet(0, 'ignored-key');
    const ignoredVideo = track([ignoredKey], ignoredKey, 1);
    const selectedKey = packet(8, 'selected-key');
    const selectedVideo = track([selectedKey], selectedKey, 2);
    const selectedAudio = track([packet(8, 'selected-audio')], undefined, 4);
    const source = inputWithTracks([ignoredVideo, selectedVideo], [selectedAudio]);
    const stream = await startMediaFragmentStream(source, sink(), {
      startSeconds: 10,
      videoTrackId: '2',
      audioTrackId: '4',
    });

    expect(stream.timelineOffsetSeconds).toBe(8);
    expect(ignoredVideo.keyPacketCalls).toHaveLength(0);
    expect(selectedVideo.keyPacketCalls).toHaveLength(1);
    await stream.completion;

    await expect(
      startMediaFragmentStream(source, sink(), { startSeconds: 10, videoTrackId: '99' }),
    ).rejects.toMatchObject({ reasons: ['video_track_not_found'] });
  });

  it('拒绝 Seek 越过已知时长和没有媒体轨道', async () => {
    await expect(
      startMediaFragmentStream(input(undefined, undefined, 10), sink(), { startSeconds: 10 }),
    ).rejects.toBeInstanceOf(MediabunnySeekOutOfRangeError);
    await expect(
      startMediaFragmentStream(input(undefined, undefined, null), sink(), { startSeconds: 1 }),
    ).rejects.toMatchObject({
      constructor: MediabunnyConversionUnsupportedError,
      reasons: ['no_media_tracks'],
    });
  });

  it('拒绝非法选项并透传上游探测错误', async () => {
    await expect(
      startMediaFragmentStream(input(), sink(), { startSeconds: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      startMediaFragmentStream(input(), sink(), { minimumFragmentDuration: 0 }),
    ).rejects.toBeInstanceOf(RangeError);

    const error = new Error('upstream failed');
    const failedInput = {
      getDurationFromMetadata: vi.fn(async () => {
        throw error;
      }),
      getPrimaryVideoTrack: vi.fn(async () => undefined),
      getPrimaryAudioTrack: vi.fn(async () => undefined),
    } as unknown as Input;
    await expect(startMediaFragmentStream(failedInput, sink(), { startSeconds: 1 })).rejects.toBe(
      error,
    );
  });
});

const packet = (timestamp: number, label: string): FakePacket => ({
  timestamp,
  label,
  clone: ({ timestamp: shifted }) => packet(shifted, label),
});

const track = (
  packets: FakePacket[],
  keyPacket?: FakePacket,
  id = 1,
  languageCode?: string,
): FakeTrack => ({
  id,
  codec: 'avc',
  packets,
  ...(keyPacket ? { keyPacket, firstKeyPacket: keyPacket } : {}),
  keyPacketCalls: [],
  firstKeyPacketCalls: [],
  getCodec: async () => 'avc',
  getDecoderConfig: async () => undefined,
  getRotation: async () => 0,
  getLanguageCode: async () => languageCode,
  getDisposition: async () => undefined,
  hasOnlyKeyPackets: async () => false,
});

const input = (video?: FakeTrack, audio?: FakeTrack, duration: number | null = 30): Input =>
  ({
    getDurationFromMetadata: vi.fn(async () => duration),
    getPrimaryVideoTrack: vi.fn(async () => video as unknown as InputVideoTrack | undefined),
    getPrimaryAudioTrack: vi.fn(async () => audio as unknown as InputAudioTrack | undefined),
    getVideoTracks: vi.fn(async () => (video ? [video] : []) as unknown as InputVideoTrack[]),
    getAudioTracks: vi.fn(async () => (audio ? [audio] : []) as unknown as InputAudioTrack[]),
  }) as unknown as Input;

const inputWithTracks = (videos: FakeTrack[], audios: FakeTrack[], duration = 30): Input =>
  ({
    getDurationFromMetadata: vi.fn(async () => duration),
    getPrimaryVideoTrack: vi.fn(async () => videos[0] as unknown as InputVideoTrack | undefined),
    getPrimaryAudioTrack: vi.fn(async () => audios[0] as unknown as InputAudioTrack | undefined),
    getVideoTracks: vi.fn(async () => videos as unknown as InputVideoTrack[]),
    getAudioTracks: vi.fn(async () => audios as unknown as InputAudioTrack[]),
  }) as unknown as Input;

const sink = () => ({
  write: vi.fn(async () => undefined),
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};
