import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionFrameWorker } from './extension-worker-bridge.js';

class TestErrorEvent extends Event {
  readonly message: string;

  constructor(type: string, init: { message: string }) {
    super(type);
    this.message = init.message;
  }
}

class TestMount {
  hidden = false;
  removed = false;
  child: TestFrame | undefined;

  setAttribute(): void {}

  attachShadow(): { append: (child: TestFrame) => void } {
    return {
      append: (child) => {
        this.child = child;
      },
    };
  }

  remove(): void {
    this.removed = true;
  }
}

class TestFrame {
  hidden = false;
  src = '';
  readonly contentWindow = { postMessage: vi.fn() };
  private onLoad: (() => void) | undefined;

  setAttribute(): void {}

  addEventListener(type: string, callback: () => void): void {
    if (type === 'load') this.onLoad = callback;
  }

  load(): void {
    this.onLoad?.();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('ExtensionFrameWorker', () => {
  it('在扩展 Frame 就绪后转发排队消息、Worker 响应、错误和终止信号', async () => {
    const mount = new TestMount();
    const frame = new TestFrame();
    const parent = { append: vi.fn() };
    vi.stubGlobal('ErrorEvent', TestErrorEvent);
    vi.stubGlobal('crypto', { randomUUID: () => 'bridge_nonce_1234567890' });
    vi.stubGlobal('document', {
      documentElement: parent,
      body: undefined,
      createElement: (tag: string) => (tag === 'iframe' ? frame : mount),
    });
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      },
    });

    const worker = new ExtensionFrameWorker(
      'chrome-extension://extension-id/media-worker.js',
      'shimweave-media-session',
    );
    const receivedByWorkerFrame: unknown[] = [];
    worker.postMessage({ type: 'init' });
    expect(frame.contentWindow.postMessage).not.toHaveBeenCalled();

    frame.contentWindow.postMessage.mockImplementation(
      (_message: unknown, _origin: string, transfer: Transferable[]) => {
        const port = transfer[0] as MessagePort;
        port.onmessage = (event) => receivedByWorkerFrame.push(event.data);
        port.start();
        port.postMessage({ type: 'ready' });
      },
    );
    frame.load();
    await flush();

    expect(parent.append).toHaveBeenCalledWith(mount);
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith(
      {
        protocol: 'shimweave-extension-worker-v1',
        type: 'connect',
        workerName: 'shimweave-media-session',
        nonce: 'bridge_nonce_1234567890',
      },
      'chrome-extension://extension-id',
      [expect.any(MessagePort)],
    );
    expect(frame.src).toBe(
      'chrome-extension://extension-id/worker-frame.html#bridge_nonce_1234567890',
    );
    expect(receivedByWorkerFrame).toEqual([{ type: 'worker-message', message: { type: 'init' } }]);

    const onMessage = vi.fn();
    const onError = vi.fn();
    worker.onmessage = onMessage;
    worker.onerror = onError;
    const bridgePort = frame.contentWindow.postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
    bridgePort.postMessage({ type: 'worker-message', message: { type: 'ready' } });
    bridgePort.postMessage({ type: 'worker-error' });
    await flush();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'ready' } }));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Extension media worker failed' }),
    );

    worker.terminate();
    await flush();
    expect(receivedByWorkerFrame.at(-1)).toEqual({ type: 'terminate' });
    expect(mount.removed).toBe(true);
  });

  it('Frame 尚未就绪时终止会丢弃排队消息且不再建立 Worker', () => {
    const mount = new TestMount();
    const frame = new TestFrame();
    vi.stubGlobal('crypto', { randomUUID: () => 'bridge_nonce_1234567890' });
    vi.stubGlobal('document', {
      documentElement: { append: vi.fn() },
      body: undefined,
      createElement: (tag: string) => (tag === 'iframe' ? frame : mount),
    });
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      },
    });
    const worker = new ExtensionFrameWorker(
      'chrome-extension://extension-id/media-worker.js',
      'shimweave-media-session',
    );
    worker.postMessage({ type: 'init' });

    worker.terminate();
    frame.load();

    expect(frame.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(mount.removed).toBe(true);
  });
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
