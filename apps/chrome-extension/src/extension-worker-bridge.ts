const EXTENSION_WORKER_BRIDGE_PROTOCOL = 'shimweave-extension-worker-v1' as const;

interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

interface QueuedMessage {
  readonly message: unknown;
  readonly transfer: Transferable[];
}

/**
 * 内容脚本不能跨 Origin 直接创建 chrome-extension Worker。
 * 该适配器只借隐藏的扩展页面创建 Worker，媒体块仍通过原生 transferable MessagePort 直达调用方。
 */
export class ExtensionFrameWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;

  private readonly mount: HTMLElement;
  private readonly port: MessagePort;
  private readonly queued: QueuedMessage[] = [];
  private ready = false;
  private closed = false;

  constructor(workerUrl: string, workerName: string) {
    const parent = document.documentElement ?? document.body;
    if (!parent) throw new ExtensionWorkerFrameUnavailableError();
    if (workerUrl !== chrome.runtime.getURL('media-worker.js')) {
      throw new ExtensionWorkerUrlUnsupportedError();
    }

    const nonce = crypto.randomUUID();
    const mount = document.createElement('span');
    mount.hidden = true;
    mount.setAttribute('aria-hidden', 'true');
    const shadow = mount.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = `${chrome.runtime.getURL('worker-frame.html')}#${nonce}`;
    frame.setAttribute('aria-hidden', 'true');
    shadow.append(frame);
    parent.append(mount);

    const channel = new MessageChannel();
    this.mount = mount;
    this.port = channel.port1;
    this.port.onmessage = (event) => this.receive(event);
    this.port.onmessageerror = () => this.fail();
    this.port.start();
    frame.addEventListener(
      'load',
      () => {
        if (this.closed) return;
        frame.contentWindow?.postMessage(
          {
            protocol: EXTENSION_WORKER_BRIDGE_PROTOCOL,
            type: 'connect',
            workerName,
            nonce,
          },
          chrome.runtime.getURL('').slice(0, -1),
          [channel.port2],
        );
      },
      { once: true },
    );
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.closed) return;
    if (!this.ready) {
      this.queued.push({ message, transfer });
      return;
    }
    this.port.postMessage({ type: 'worker-message', message }, transfer);
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queued of this.queued.splice(0)) closeMessagePorts(queued.transfer);
    if (this.ready) this.port.postMessage({ type: 'terminate' });
    this.port.close();
    this.mount.remove();
  }

  private receive(event: MessageEvent): void {
    if (this.closed || !isRecord(event.data)) return;
    if (event.data.type === 'ready') {
      if (this.ready) return;
      this.ready = true;
      for (const queued of this.queued.splice(0)) {
        this.port.postMessage({ type: 'worker-message', message: queued.message }, queued.transfer);
      }
      return;
    }
    if (event.data.type === 'worker-message') {
      this.onmessage?.(new MessageEvent('message', { data: event.data.message }));
      return;
    }
    if (event.data.type === 'worker-error') this.fail();
  }

  private fail(): void {
    if (this.closed) return;
    this.onerror?.(new ErrorEvent('error', { message: 'Extension media worker failed' }));
  }
}

export const createExtensionFrameWorker = (url: string, name: string): WorkerLike =>
  new ExtensionFrameWorker(url, name);

export class ExtensionWorkerFrameUnavailableError extends Error {
  constructor() {
    super('Extension worker frame cannot be mounted before the document exists');
    this.name = 'ExtensionWorkerFrameUnavailableError';
  }
}

export class ExtensionWorkerUrlUnsupportedError extends Error {
  constructor() {
    super('Extension worker bridge only supports the packaged media worker');
    this.name = 'ExtensionWorkerUrlUnsupportedError';
  }
}

const closeMessagePorts = (transferables: readonly Transferable[]): void => {
  if (typeof MessagePort !== 'function') return;
  for (const transferable of transferables) {
    if (transferable instanceof MessagePort) transferable.close();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
