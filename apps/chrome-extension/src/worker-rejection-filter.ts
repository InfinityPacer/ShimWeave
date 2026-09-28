/**
 * 取消或换代时，媒体引擎内部仍有未被等待的写入、读取 Promise，会以这些终止错误拒绝。
 * 它们是预期的收尾，不代表播放失败；只把它们标记为已处理，其余未处理拒绝照常上报。
 */
const EXPECTED_TERMINATION_ERRORS: ReadonlySet<string> = new Set([
  'WorkerFragmentSinkClosedError',
  'MediaWorkerStreamCancelledError',
  'MediabunnyFragmentStreamCancelledError',
  'MediabunnySubtitleStreamCancelledError',
  'MediabunnyMediaSessionClosedError',
  'MediabunnySourceDisposedError',
  'RangeBrokerClosedError',
  'AbortError',
]);

export const isExpectedStreamTermination = (reason: unknown): boolean => {
  const visited = new Set<unknown>();
  let current = reason;
  while (current instanceof Error && !visited.has(current)) {
    if (EXPECTED_TERMINATION_ERRORS.has(current.name)) return true;
    visited.add(current);
    current = current.cause;
  }
  return false;
};

interface RejectionScope {
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: { readonly reason: unknown; preventDefault(): void }) => void,
  ): void;
}

export const installStreamTerminationFilter = (scope: RejectionScope): void => {
  scope.addEventListener('unhandledrejection', (event) => {
    if (isExpectedStreamTermination(event.reason)) event.preventDefault();
  });
};
