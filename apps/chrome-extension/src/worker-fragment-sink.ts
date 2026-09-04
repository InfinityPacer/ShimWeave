import {
  MEDIA_WORKER_PROTOCOL,
  type MediaWorkerStreamChunkMessage,
} from './media-worker-protocol.js';

export interface WorkerFragmentSinkOptions {
  requestId: string;
  postMessage(message: MediaWorkerStreamChunkMessage, transfer: Transferable[]): void;
  maxBootstrapBytes?: number;
}

interface BufferedChunk {
  id: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface PendingChunk {
  id: string;
  resolve(): void;
  reject(error: unknown): void;
}

const DEFAULT_MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;

/** WorkerFragmentSink 在 MIME 就绪前有界缓存，之后每个 chunk 必须等待页面 ACK。 */
export class WorkerFragmentSink {
  private readonly requestId: string;
  private readonly postMessage: WorkerFragmentSinkOptions['postMessage'];
  private readonly maxBootstrapBytes: number;
  private readonly buffered: BufferedChunk[] = [];
  private bufferedBytes = 0;
  private sequence = 0;
  private activated = false;
  private closed = false;
  private pending: PendingChunk | undefined;
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(options: WorkerFragmentSinkOptions) {
    this.requestId = options.requestId;
    this.postMessage = options.postMessage;
    this.maxBootstrapBytes = options.maxBootstrapBytes ?? DEFAULT_MAX_BOOTSTRAP_BYTES;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new WorkerFragmentSinkClosedError());
    if (!this.activated) {
      const owned = Uint8Array.from(bytes);
      if (this.bufferedBytes + owned.byteLength > this.maxBootstrapBytes) {
        return Promise.reject(new WorkerFragmentBootstrapLimitError(this.maxBootstrapBytes));
      }
      this.buffered.push({ id: String(this.sequence++), bytes: owned });
      this.bufferedBytes += owned.byteLength;
      return Promise.resolve();
    }
    const owned = compactArray(bytes);
    const id = String(this.sequence++);
    const scheduled = this.flushPromise.then(() => this.send({ id, bytes: owned }));
    this.flushPromise = scheduled.catch(() => undefined);
    return scheduled;
  }

  activate(): Promise<void> {
    if (this.closed) return Promise.reject(new WorkerFragmentSinkClosedError());
    if (this.activated) return this.flushPromise;
    this.activated = true;
    const chunks = this.buffered.splice(0);
    this.bufferedBytes = 0;
    const flushing = chunks.reduce(
      (previous, chunk) => previous.then(() => this.send(chunk)),
      this.flushPromise,
    );
    this.flushPromise = flushing.catch(() => undefined);
    return flushing;
  }

  acknowledge(chunkId: string): void {
    if (!this.pending || this.pending.id !== chunkId) return;
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve();
  }

  abort(reason: unknown = new WorkerFragmentSinkClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    this.buffered.length = 0;
    this.bufferedBytes = 0;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(reason);
  }

  close(): Promise<void> {
    return this.flushPromise;
  }

  private send(chunk: BufferedChunk): Promise<void> {
    if (this.closed) return Promise.reject(new WorkerFragmentSinkClosedError());
    if (this.pending) return Promise.reject(new WorkerFragmentSinkStateError());
    return new Promise<void>((resolve, reject) => {
      this.pending = { id: chunk.id, resolve, reject };
      const buffer = chunk.bytes.buffer;
      this.postMessage(
        {
          protocol: MEDIA_WORKER_PROTOCOL,
          type: 'stream-chunk',
          requestId: this.requestId,
          chunkId: chunk.id,
          bytes: buffer,
        },
        [buffer],
      );
    });
  }
}

export class WorkerFragmentBootstrapLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Fragment bootstrap exceeded ${limit} bytes before MIME became available`);
    this.name = 'WorkerFragmentBootstrapLimitError';
  }
}

export class WorkerFragmentSinkClosedError extends Error {
  constructor() {
    super('Worker fragment sink is closed');
    this.name = 'WorkerFragmentSinkClosedError';
  }
}

export class WorkerFragmentSinkStateError extends Error {
  constructor() {
    super('Worker fragment sink already has an unacknowledged chunk');
    this.name = 'WorkerFragmentSinkStateError';
  }
}

const compactArray = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return Uint8Array.from(bytes);
};
