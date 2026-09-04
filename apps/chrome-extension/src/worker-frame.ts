import { MEDIA_WORKER_PROTOCOL, type MediaWorkerInitMessage } from './media-worker-protocol.js';

const EXTENSION_WORKER_BRIDGE_PROTOCOL = 'shimweave-extension-worker-v1' as const;

let connected = false;
const expectedNonce = location.hash.slice(1);

/** 扩展页面只负责建立 extension-origin Worker，并以 transferable MessagePort 转发媒体协议。 */
window.addEventListener('message', (event: MessageEvent) => {
  if (connected || event.source !== window.parent || !isConnectMessage(event.data, expectedNonce)) {
    return;
  }
  const port = event.ports[0];
  if (!port) return;
  connected = true;
  connectWorker(port, event.data.workerName);
});

const connectWorker = (port: MessagePort, workerName: string): void => {
  let worker: Worker;
  try {
    worker = new Worker(chrome.runtime.getURL('media-worker.js'), {
      type: 'module',
      name: workerName,
    });
  } catch {
    port.postMessage({ type: 'worker-error' });
    port.close();
    return;
  }

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    worker.terminate();
    port.close();
  };
  window.addEventListener('pagehide', close, { once: true });
  worker.onmessage = (event) => {
    if (closed) return;
    const transfer = transferableResponse(event.data);
    port.postMessage({ type: 'worker-message', message: event.data }, transfer);
  };
  worker.onerror = () => {
    if (closed) return;
    port.postMessage({ type: 'worker-error' });
    close();
  };
  port.onmessage = (event) => {
    if (closed) return;
    if (!isRecord(event.data)) return;
    if (event.data.type === 'terminate') {
      close();
      return;
    }
    if (event.data.type !== 'worker-message') return;
    const message = attachSharedCoordinator(event.data.message);
    worker.postMessage(message, transferableRequest(message));
  };
  port.onmessageerror = close;
  port.start();
  port.postMessage({ type: 'ready' });
};

const attachSharedCoordinator = (value: unknown): unknown => {
  if (!isMediaWorkerInit(value) || value.coordinatorPort || typeof SharedWorker !== 'function') {
    return value;
  }
  try {
    const coordinator = new SharedWorker(chrome.runtime.getURL('range-coordinator.js'), {
      type: 'module',
      name: 'shimweave-range-v1',
    });
    return { ...value, coordinatorPort: coordinator.port } satisfies MediaWorkerInitMessage;
  } catch {
    return value;
  }
};

const transferableRequest = (value: unknown): Transferable[] => {
  if (!isRecord(value)) return [];
  return value.coordinatorPort instanceof MessagePort ? [value.coordinatorPort] : [];
};

const transferableResponse = (value: unknown): Transferable[] => {
  if (!isRecord(value)) return [];
  return value.bytes instanceof ArrayBuffer ? [value.bytes] : [];
};

const isConnectMessage = (
  value: unknown,
  expectedNonce: string,
): value is {
  protocol: typeof EXTENSION_WORKER_BRIDGE_PROTOCOL;
  type: 'connect';
  workerName: string;
  nonce: string;
} =>
  isRecord(value) &&
  value.protocol === EXTENSION_WORKER_BRIDGE_PROTOCOL &&
  value.type === 'connect' &&
  typeof value.workerName === 'string' &&
  /^[A-Za-z0-9_-]{1,128}$/.test(value.workerName) &&
  opaqueId(expectedNonce) &&
  value.nonce === expectedNonce;

const isMediaWorkerInit = (value: unknown): value is MediaWorkerInitMessage =>
  isRecord(value) && value.protocol === MEDIA_WORKER_PROTOCOL && value.type === 'init';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
