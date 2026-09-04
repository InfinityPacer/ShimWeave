import { RangeLeaseCoordinator, RangeScheduler } from '@shimweave/core';
import { MEDIA_RANGE_SCHEDULER_OPTIONS } from './range-policy.js';

interface SharedWorkerScope {
  onconnect: ((event: MessageEvent) => void) | null;
}

const coordinator = new RangeLeaseCoordinator({
  scheduler: new RangeScheduler(MEDIA_RANGE_SCHEDULER_OPTIONS),
});
const scope = globalThis as unknown as SharedWorkerScope;

// 每个 Player Frame 只提交控制消息；真实 Range Fetch 始终在请求方自己的 Worker 内执行。
scope.onconnect = (event) => {
  for (const port of event.ports) coordinator.attach(port);
};
