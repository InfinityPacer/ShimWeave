import { describe, expect, it, vi } from 'vitest';
import {
  WorkerFragmentBootstrapLimitError,
  WorkerFragmentSink,
  WorkerFragmentSinkClosedError,
} from './worker-fragment-sink.js';

describe('WorkerFragmentSink', () => {
  it('在 MIME 就绪前复制有界数据，并逐块等待 ACK 后继续', async () => {
    const posted: Array<{ bytes: ArrayBuffer; chunkId: string; transfer: Transferable[] }> = [];
    const sink = new WorkerFragmentSink({
      requestId: 'stream',
      postMessage: (message, transfer) => {
        posted.push({ bytes: message.bytes, chunkId: message.chunkId, transfer });
      },
    });
    const source = new Uint8Array([1, 2, 3]);
    await sink.write(source);
    source[0] = 9;

    let activated = false;
    const activation = sink.activate().then(() => {
      activated = true;
    });
    await Promise.resolve();

    expect(activated).toBe(false);
    expect(new Uint8Array(posted[0]?.bytes ?? new ArrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(posted[0]?.transfer).toEqual([posted[0]?.bytes]);

    sink.acknowledge(posted[0]?.chunkId ?? '');
    await activation;
    expect(activated).toBe(true);
  });

  it('拒绝超过启动缓冲上限的数据', async () => {
    const sink = new WorkerFragmentSink({
      requestId: 'stream',
      maxBootstrapBytes: 2,
      postMessage: vi.fn(),
    });

    await expect(sink.write(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      WorkerFragmentBootstrapLimitError,
    );
  });

  it('取消时拒绝正在等待 ACK 的写入', async () => {
    const sink = new WorkerFragmentSink({ requestId: 'stream', postMessage: vi.fn() });
    await sink.activate();
    const pending = sink.write(new Uint8Array([1]));

    sink.abort();

    await expect(pending).rejects.toBeInstanceOf(WorkerFragmentSinkClosedError);
  });
});
