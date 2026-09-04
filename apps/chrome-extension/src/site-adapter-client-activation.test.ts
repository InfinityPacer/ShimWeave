import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteAdapterClientActivation } from './site-adapter-client-activation.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('SiteAdapterClientActivation', () => {
  afterEach(() => vi.useRealTimers());

  it('watcher 就绪前不请求激活，且重复 ready 只执行一次', async () => {
    const activate = vi.fn(async () => true);
    const lifecycle = new SiteAdapterClientActivation({ activate });

    lifecycle.reactivate();
    expect(activate).not.toHaveBeenCalled();
    lifecycle.watcherReady();
    lifecycle.watcherReady();
    await flush();

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('Service Worker 恢复通知会重新握手', async () => {
    const activate = vi.fn(async () => true);
    const lifecycle = new SiteAdapterClientActivation({ activate });
    lifecycle.watcherReady();
    await flush();

    lifecycle.reactivate();
    await flush();

    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('激活进行中收到恢复通知时只追加一次执行', async () => {
    let finish: ((value: boolean) => void) | undefined;
    const activate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const lifecycle = new SiteAdapterClientActivation({ activate });
    lifecycle.watcherReady();
    lifecycle.reactivate();
    lifecycle.reactivate();

    finish?.(true);
    await flush();

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('临时激活失败后按有界退避重试', async () => {
    vi.useFakeTimers();
    const activate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lifecycle = new SiteAdapterClientActivation({ activate });
    lifecycle.watcherReady();
    await flush();
    expect(activate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(activate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('持续失败达到上限后停止重试', async () => {
    vi.useFakeTimers();
    const activate = vi.fn(async () => false);
    const lifecycle = new SiteAdapterClientActivation({
      activate,
      retryDelaysMs: [10, 20],
    });
    lifecycle.watcherReady();
    await flush();

    await vi.advanceTimersByTimeAsync(100);

    expect(activate).toHaveBeenCalledTimes(3);
  });

  it('停止后忽略迟到 ready 和恢复通知', async () => {
    const activate = vi.fn(async () => true);
    const lifecycle = new SiteAdapterClientActivation({ activate });
    lifecycle.stop();
    lifecycle.watcherReady();
    lifecycle.reactivate();
    await flush();

    expect(activate).not.toHaveBeenCalled();
  });
});
