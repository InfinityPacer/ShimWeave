import { mediabunnyMediaEngine } from '@shimweave/engine-mediabunny';
import { DedicatedMediaWorkerHost } from './media-worker-host.js';

interface DedicatedWorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as DedicatedWorkerScope;
const host = new DedicatedMediaWorkerHost({
  postMessage: (message, transfer) => scope.postMessage(message, transfer),
  mediaEngine: mediabunnyMediaEngine,
});

scope.onmessage = (event) => host.receive(event.data);
