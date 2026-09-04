import type { ByteRange, ByteSource } from '@shimweave/contracts';
import { CustomSource, Input } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import {
  MediabunnyByteSourceAdapter,
  MediabunnySourceDisposedError,
  MediabunnySourceReadError,
} from './source-adapter.js';

class RecordingSource implements ByteSource {
  readonly sourceId = 'recording-source';
  readonly reads: Array<{ range: ByteRange; signal: AbortSignal | undefined }> = [];
  sizeCalls = 0;
  closeCalls = 0;
  size = 16;
  readResult: Uint8Array | undefined;

  getSize(): Promise<number> {
    this.sizeCalls += 1;
    return Promise.resolve(this.size);
  }

  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.reads.push({ range: { ...range }, signal });
    return Promise.resolve(
      this.readResult ??
        Uint8Array.from({ length: range.end - range.start }, (_, offset) => range.start + offset),
    );
  }

  close(): void {
    this.closeCalls += 1;
  }
}

describe('MediabunnyByteSourceAdapter', () => {
  it('提供真实 CustomSource 并复用经过校验的尺寸', async () => {
    const bytes = new RecordingSource();
    const adapter = new MediabunnyByteSourceAdapter(bytes);

    expect(adapter.source).toBeInstanceOf(CustomSource);
    await expect(Promise.all([adapter.getSize(), adapter.getSize()])).resolves.toEqual([16, 16]);
    await expect(adapter.getSize()).resolves.toBe(16);
    expect(bytes.sizeCalls).toBe(1);
  });

  it('按半开区间转发读取并共享会话生命周期信号', async () => {
    const bytes = new RecordingSource();
    const adapter = new MediabunnyByteSourceAdapter(bytes);

    await adapter.getSize();
    await expect(adapter.read(4, 8)).resolves.toEqual(Uint8Array.from([4, 5, 6, 7]));
    expect(bytes.reads[0]?.range).toEqual({ start: 4, end: 8 });
    expect(bytes.reads[0]?.signal?.aborted).toBe(false);
  });

  it('在适配边界拒绝非法区间、越界读取和错误长度', async () => {
    const bytes = new RecordingSource();
    const adapter = new MediabunnyByteSourceAdapter(bytes);

    await adapter.getSize();
    await expect(adapter.read(4, 4)).rejects.toBeInstanceOf(RangeError);
    await expect(adapter.read(15, 17)).rejects.toBeInstanceOf(RangeError);

    bytes.readResult = Uint8Array.from([1]);
    await expect(adapter.read(0, 2)).rejects.toBeInstanceOf(MediabunnySourceReadError);
  });

  it('dispose 同步中止生命周期且 close 只执行一次', async () => {
    const bytes = new RecordingSource();
    const adapter = new MediabunnyByteSourceAdapter(bytes);
    await adapter.read(0, 1);

    adapter.dispose();
    adapter.dispose();
    await adapter.close();

    expect(bytes.reads[0]?.signal?.aborted).toBe(true);
    expect(bytes.closeCalls).toBe(1);
    await expect(adapter.read(0, 1)).rejects.toBeInstanceOf(MediabunnySourceDisposedError);
  });

  it('真实 Input.dispose 会释放最后一个 SourceRef 并关闭底层源', async () => {
    const bytes = new RecordingSource();
    const adapter = new MediabunnyByteSourceAdapter(bytes);
    const input = new Input({ source: adapter.source, formats: [] });

    input.dispose();
    await adapter.close();

    expect(bytes.closeCalls).toBe(1);
    await expect(adapter.read(0, 1)).rejects.toBeInstanceOf(MediabunnySourceDisposedError);
  });

  it('观察异步关闭失败但仍向显式 close 返回原始错误', async () => {
    const error = new Error('close failed');
    const onDisposeError = vi.fn();
    const bytes = new RecordingSource();
    bytes.close = () => {
      bytes.closeCalls += 1;
      throw error;
    };
    const adapter = new MediabunnyByteSourceAdapter(bytes, { onDisposeError });

    await expect(adapter.close()).rejects.toBe(error);
    expect(onDisposeError).toHaveBeenCalledWith(error);
    expect(bytes.closeCalls).toBe(1);
  });
});
