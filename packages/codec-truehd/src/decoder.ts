import createTrueHdModule, { type TrueHdModule } from '../wasm/truehd-wasm.mjs';

/** 请求的输出声道数：2 与 6 取流内对应的呈现子流，8 解出流内最完整的呈现。 */
export type TrueHdOutputChannels = 2 | 6 | 8;

export interface TrueHdDecoderOptions {
  /** 默认 2。流内没有匹配的呈现时，实际声道数以 DecodedAudio.numberOfChannels 为准。 */
  channels?: TrueHdOutputChannels;
}

/** 一段连续 PCM；同一个包内格式不变的访问单元合并为一段。 */
export interface DecodedAudio {
  sampleRate: number;
  numberOfChannels: number;
  /** 每声道的采样帧数。 */
  numberOfFrames: number;
  /** FFmpeg 的声道布局描述，例如 `stereo`、`5.1(side)`；planes 按该布局的原生顺序排列。 */
  channelLayout: string;
  /** 每声道一个 Float32Array，取值范围 [-1, 1)，由调用方持有，不引用 WASM 内存。 */
  planes: Float32Array[];
}

export interface TrueHdDecoder {
  /**
   * 解码一个 Matroska Block 负载，可包含一个或多个完整的 TrueHD 访问单元。
   * 在遇到 major sync 之前的访问单元不产生输出；损坏的访问单元被跳过并计入 corruptUnits。
   */
  decode(packet: Uint8Array): DecodedAudio[];
  /** 丢弃跨包状态，用于 Seek。TrueHD 没有延迟输出，因此不会返回残留音频。 */
  flush(): void;
  /** 释放 WASM 内的解码上下文；之后再调用 decode 会抛错。 */
  close(): void;
  /** 被跳过的损坏访问单元累计数。 */
  readonly corruptUnits: number;
}

interface Bridge {
  module: TrueHdModule;
  open: (channels: number) => number;
  input: (ctx: number, size: number) => number;
  next: (ctx: number) => number;
  channels: (ctx: number) => number;
  samples: (ctx: number) => number;
  rate: (ctx: number) => number;
  data: (ctx: number) => number;
  layout: (ctx: number) => number;
  reset: (ctx: number) => void;
  close: (ctx: number) => void;
}

// 与 native/bridge.c 中 thd_next 的返回约定一致。
const UNIT_DECODED = 2;
const UNIT_EMPTY = 1;
const INPUT_DONE = 0;
// FFmpeg 的 AVERROR_INVALIDDATA，表示单个访问单元损坏，可以继续处理后续单元。
const AVERROR_INVALIDDATA = -1094995529;

let bridgePromise: Promise<Bridge> | undefined;

// 同一执行上下文（页面或 Worker）共享一个 WASM 实例，多个解码器各自持有独立的 C 上下文。
const loadBridge = (): Promise<Bridge> => {
  bridgePromise ??= createTrueHdModule().then((module) => {
    const fn = (name: string, returnType: 'number' | null, args: number) =>
      module.cwrap(
        name,
        returnType,
        Array.from({ length: args }, () => 'number' as const),
      );
    return {
      module,
      open: fn('thd_open', 'number', 1) as Bridge['open'],
      input: fn('thd_input', 'number', 2) as Bridge['input'],
      next: fn('thd_next', 'number', 1) as Bridge['next'],
      channels: fn('thd_frame_channels', 'number', 1) as Bridge['channels'],
      samples: fn('thd_frame_samples', 'number', 1) as Bridge['samples'],
      rate: fn('thd_frame_rate', 'number', 1) as Bridge['rate'],
      data: fn('thd_frame_data', 'number', 1) as Bridge['data'],
      layout: fn('thd_frame_layout', 'number', 1) as Bridge['layout'],
      reset: fn('thd_reset', null, 1) as Bridge['reset'],
      close: fn('thd_close', null, 1) as Bridge['close'],
    };
  });
  bridgePromise.catch(() => {
    bridgePromise = undefined;
  });
  return bridgePromise;
};

interface PendingSegment {
  sampleRate: number;
  numberOfChannels: number;
  channelLayout: string;
  chunks: Float32Array[][];
  numberOfFrames: number;
}

const finishSegment = (segment: PendingSegment): DecodedAudio => {
  const planes = Array.from({ length: segment.numberOfChannels }, (_, channel) => {
    if (segment.chunks.length === 1) return segment.chunks[0]?.[channel] ?? new Float32Array();
    const plane = new Float32Array(segment.numberOfFrames);
    let offset = 0;
    for (const chunk of segment.chunks) {
      const part = chunk[channel];
      if (!part) continue;
      plane.set(part, offset);
      offset += part.length;
    }
    return plane;
  });
  return {
    sampleRate: segment.sampleRate,
    numberOfChannels: segment.numberOfChannels,
    numberOfFrames: segment.numberOfFrames,
    channelLayout: segment.channelLayout,
    planes,
  };
};

class WasmTrueHdDecoder implements TrueHdDecoder {
  #bridge: Bridge;
  #ctx: number;
  #corruptUnits = 0;

  constructor(bridge: Bridge, ctx: number) {
    this.#bridge = bridge;
    this.#ctx = ctx;
  }

  get corruptUnits(): number {
    return this.#corruptUnits;
  }

  decode(packet: Uint8Array): DecodedAudio[] {
    const ctx = this.#requireContext();
    const bridge = this.#bridge;
    if (packet.byteLength === 0) return [];

    const pointer = bridge.input(ctx, packet.byteLength);
    if (pointer === 0) throw new Error('TrueHD decoder could not allocate its input buffer.');
    bridge.module.HEAPU8.set(packet, pointer);

    const output: DecodedAudio[] = [];
    let segment: PendingSegment | undefined;

    for (;;) {
      const status = bridge.next(ctx);
      if (status === INPUT_DONE) break;
      if (status === UNIT_EMPTY) continue;
      if (status < 0) {
        if (status !== AVERROR_INVALIDDATA) {
          throw new Error(`TrueHD decoder failed with FFmpeg error ${status}.`);
        }
        this.#corruptUnits += 1;
        continue;
      }
      if (status !== UNIT_DECODED) throw new Error(`Unexpected TrueHD bridge status ${status}.`);

      const numberOfChannels = bridge.channels(ctx);
      const numberOfFrames = bridge.samples(ctx);
      const sampleRate = bridge.rate(ctx);
      const channelLayout = bridge.module.UTF8ToString(bridge.layout(ctx));
      // 每次读取都重新取 HEAPF32：内存增长后旧视图会失效。
      const base = bridge.data(ctx) >>> 2;
      const heap = bridge.module.HEAPF32;
      const chunk = Array.from({ length: numberOfChannels }, (_, channel) => {
        const start = base + channel * numberOfFrames;
        return heap.slice(start, start + numberOfFrames);
      });

      if (
        segment &&
        segment.sampleRate === sampleRate &&
        segment.numberOfChannels === numberOfChannels &&
        segment.channelLayout === channelLayout
      ) {
        segment.chunks.push(chunk);
        segment.numberOfFrames += numberOfFrames;
      } else {
        if (segment) output.push(finishSegment(segment));
        segment = { sampleRate, numberOfChannels, channelLayout, chunks: [chunk], numberOfFrames };
      }
    }

    if (segment) output.push(finishSegment(segment));
    return output;
  }

  flush(): void {
    this.#bridge.reset(this.#requireContext());
  }

  close(): void {
    if (this.#ctx === 0) return;
    this.#bridge.close(this.#ctx);
    this.#ctx = 0;
  }

  #requireContext(): number {
    if (this.#ctx === 0) throw new Error('TrueHD decoder is closed.');
    return this.#ctx;
  }
}

/** 创建 TrueHD 解码器。首次调用会在当前执行上下文内编译随包提供的 WASM。 */
export const createTrueHdDecoder = async (
  options: TrueHdDecoderOptions = {},
): Promise<TrueHdDecoder> => {
  const channels = options.channels ?? 2;
  if (channels !== 2 && channels !== 6 && channels !== 8) {
    throw new RangeError(`Unsupported TrueHD output channel count: ${String(channels)}.`);
  }
  const bridge = await loadBridge();
  const ctx = bridge.open(channels);
  if (ctx === 0) throw new Error('TrueHD decoder could not be initialized.');
  return new WasmTrueHdDecoder(bridge, ctx);
};
