import { describe, expect, it, vi } from 'vitest';
import { WorkerFragmentSinkClosedError } from './worker-fragment-sink.js';
import {
  installStreamTerminationFilter,
  isExpectedStreamTermination,
} from './worker-rejection-filter.js';

describe('Worker 未处理拒绝过滤', () => {
  it('只把取消与关闭产生的终止错误视为预期，包括被包装的原因', () => {
    expect(isExpectedStreamTermination(new WorkerFragmentSinkClosedError())).toBe(true);
    expect(
      isExpectedStreamTermination(
        new Error('conversion failed', { cause: new WorkerFragmentSinkClosedError() }),
      ),
    ).toBe(true);
    expect(isExpectedStreamTermination(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isExpectedStreamTermination(new TypeError('decode failed'))).toBe(false);
    expect(isExpectedStreamTermination('WorkerFragmentSinkClosedError')).toBe(false);
  });

  it('预期的终止错误被标记为已处理，其他拒绝照常上报', () => {
    const listeners: ((event: { reason: unknown; preventDefault(): void }) => void)[] = [];
    installStreamTerminationFilter({
      addEventListener: (_type, listener) => listeners.push(listener),
    });
    const expected = { reason: new WorkerFragmentSinkClosedError(), preventDefault: vi.fn() };
    const unexpected = { reason: new Error('bug'), preventDefault: vi.fn() };
    for (const listener of listeners) {
      listener(expected);
      listener(unexpected);
    }
    expect(expected.preventDefault).toHaveBeenCalledOnce();
    expect(unexpected.preventDefault).not.toHaveBeenCalled();
  });
});
