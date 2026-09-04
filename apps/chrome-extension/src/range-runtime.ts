import type { RangeLeasePort } from '@shimweave/core';
import {
  RangeLeaseSchedulerClient,
  type RangeLeaseSchedulerClientOptions,
  RangeScheduler,
  type RangeSchedulerOptions,
  type RangeTaskScheduler,
} from '@shimweave/core';

export type RangeSchedulerMode = 'shared' | 'local';
export type RangeSchedulerFallbackReason =
  | 'shared-worker-unavailable'
  | 'shared-worker-handshake-failed';

export interface BrowserRangeSchedulerRuntime {
  /** shared 表示跨 Player Frame 仲裁，local 是安全的单页面降级。 */
  readonly mode: RangeSchedulerMode;
  readonly fallbackReason?: RangeSchedulerFallbackReason;
  readonly scheduler: RangeTaskScheduler;
  close(): Promise<void>;
}

interface SharedWorkerLike {
  readonly port: RangeLeasePort;
}

export interface BrowserRangeSchedulerOptions {
  workerURL?: string;
  workerName?: string;
  createSharedWorker?: (url: string, name: string) => SharedWorkerLike;
  leaseClient?: RangeLeaseSchedulerClientOptions;
  localScheduler?: RangeSchedulerOptions;
}

const DEFAULT_WORKER_NAME = 'shimweave-range-v1';

/**
 * 创建浏览器 Range 调度器。SharedWorker 不可用或协议不兼容时，降级仅缩小协调范围，
 * 不改变 CDN 到当前浏览器执行上下文的数据路径。
 */
export const createBrowserRangeScheduler = async (
  options: BrowserRangeSchedulerOptions = {},
): Promise<BrowserRangeSchedulerRuntime> => {
  const createSharedWorker = options.createSharedWorker ?? defaultSharedWorkerFactory();
  if (!createSharedWorker) return createLocalRuntime(options, 'shared-worker-unavailable');

  let client: RangeLeaseSchedulerClient | undefined;
  try {
    const url = options.workerURL ?? chrome.runtime.getURL('range-coordinator.js');
    const worker = createSharedWorker(url, options.workerName ?? DEFAULT_WORKER_NAME);
    client = new RangeLeaseSchedulerClient(worker.port, options.leaseClient);
    await client.whenReady();
    const sharedClient = client;
    return {
      mode: 'shared',
      scheduler: sharedClient,
      close: () => sharedClient.close(),
    };
  } catch (error) {
    await client?.close(error);
    return createLocalRuntime(options, 'shared-worker-handshake-failed');
  }
};

const defaultSharedWorkerFactory = ():
  | BrowserRangeSchedulerOptions['createSharedWorker']
  | undefined => {
  if (typeof SharedWorker !== 'function') return undefined;
  return (url, name) => new SharedWorker(url, { name, type: 'module' });
};

const createLocalRuntime = (
  options: BrowserRangeSchedulerOptions,
  fallbackReason: RangeSchedulerFallbackReason,
): BrowserRangeSchedulerRuntime => {
  const scheduler = new RangeScheduler(options.localScheduler);
  return {
    mode: 'local',
    fallbackReason,
    scheduler,
    close: () => scheduler.close(),
  };
};
