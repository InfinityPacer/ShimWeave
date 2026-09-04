import type { ByteSource } from '@shimweave/contracts';
import { CustomSource } from 'mediabunny';

export interface MediabunnyByteSourceAdapterOptions {
  onDisposeError?: (error: unknown) => void;
}

/**
 * 将项目的可取消 ByteSource 接入 Mediabunny，并关闭其内部缓存和预取以保持唯一调度权。
 */
export class MediabunnyByteSourceAdapter {
  readonly source: CustomSource;

  private readonly lifetime = new AbortController();
  private readonly onDisposeError: ((error: unknown) => void) | undefined;
  private size: number | undefined;
  private sizePromise: Promise<number> | undefined;
  private closePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly bytes: ByteSource,
    options: MediabunnyByteSourceAdapterOptions = {},
  ) {
    this.onDisposeError = options.onDisposeError;
    this.source = new CustomSource({
      getSize: () => this.getSize(),
      read: (start, end) => this.read(start, end),
      dispose: () => this.dispose(),
      maxCacheSize: 0,
      prefetchProfile: 'none',
    });
  }

  getSize(): Promise<number> {
    this.assertActive();
    if (this.size !== undefined) return Promise.resolve(this.size);
    if (!this.sizePromise) {
      const pending = this.bytes.getSize(this.lifetime.signal).then((size) => {
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new RangeError('Byte source size must be a non-negative safe integer');
        }
        this.size = size;
        return size;
      });
      this.sizePromise = pending.catch((error: unknown) => {
        this.sizePromise = undefined;
        throw error;
      });
    }
    return this.sizePromise;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    this.assertActive();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw new RangeError('Mediabunny requested an invalid byte interval');
    }
    if (this.size !== undefined && end > this.size) {
      throw new RangeError('Mediabunny requested bytes beyond the source size');
    }

    const result = await this.bytes.read({ start, end }, this.lifetime.signal);
    const expected = end - start;
    if (result.byteLength !== expected) {
      throw new MediabunnySourceReadError(expected, result.byteLength);
    }
    return result;
  }

  /** Input.dispose 会同步调用此方法；异步底层关闭由 close() 提供可等待边界。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new MediabunnySourceDisposedError());
    const closing = Promise.resolve().then(() => this.bytes.close());
    this.closePromise = closing;
    void closing.catch((error: unknown) => {
      try {
        this.onDisposeError?.(error);
      } catch {
        // 错误观察器不能制造未处理 rejection；显式 close() 仍会返回原始失败。
      }
    });
  }

  async close(): Promise<void> {
    this.dispose();
    await this.closePromise;
  }

  private assertActive(): void {
    if (this.disposed) throw new MediabunnySourceDisposedError();
  }
}

export class MediabunnySourceReadError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Byte source returned ${actual} bytes; expected ${expected}`);
    this.name = 'MediabunnySourceReadError';
  }
}

export class MediabunnySourceDisposedError extends Error {
  constructor() {
    super('Mediabunny byte source adapter is disposed');
    this.name = 'MediabunnySourceDisposedError';
  }
}
