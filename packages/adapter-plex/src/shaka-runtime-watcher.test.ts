import { describe, expect, it, vi } from 'vitest';
import type { PlexShakaRuntime } from './native-hook.js';
import { PlexShakaRuntimeWatcher } from './shaka-runtime-watcher.js';

describe('PlexShakaRuntimeWatcher', () => {
  it('普通页面没有 Plex webpack runtime 时不报告站点证据', () => {
    const onObserved = vi.fn();
    const schedule = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const watcher = new PlexShakaRuntimeWatcher({
      host: {},
      onObserved,
      onRuntime: () => undefined,
      schedule,
      cancelSchedule: () => undefined,
    });

    watcher.start();

    expect(onObserved).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it('首次播放晚于页面加载时仍从动态 chunk 发现 Shaka', () => {
    const factories: Record<string, (...args: unknown[]) => unknown> = {};
    const exports = new Map<string, unknown>();
    const runtimeRequire = Object.assign((moduleId: string) => exports.get(moduleId), {
      m: factories,
    });
    const chunks: unknown[] = [];
    const webpackPush = ((
      entry: [
        unknown,
        Record<string, (typeof factories)[string]>,
        (runtime: typeof runtimeRequire) => void,
      ],
    ) => {
      Object.assign(factories, entry[1]);
      entry[2]?.(runtimeRequire);
      return chunks.length;
    }) as typeof chunks.push;
    chunks.push = webpackPush;
    const runtimes: PlexShakaRuntime[] = [];
    const onObserved = vi.fn();
    const schedule = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const watcher = new PlexShakaRuntimeWatcher({
      host: { webpackChunkplex_web: chunks },
      onObserved,
      onRuntime: (runtime) => runtimes.push(runtime),
      schedule,
      cancelSchedule: () => undefined,
    });
    watcher.start();
    expect(onObserved).toHaveBeenCalledOnce();
    expect(runtimes).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();

    class Player {
      static readonly version = '3.3.1';
      async load(): Promise<void> {}
      async unload(): Promise<void> {}
      getMediaElement(): null {
        return null;
      }
    }
    const factory = (): void => {
      void 'shaka.Player';
      void 'NetworkingEngine';
      void 'registerScheme';
    };
    exports.set('late-shaka', {
      Player,
      net: { NetworkingEngine: class NetworkingEngine {} },
    });
    chunks.push([['late'], { 'late-shaka': factory }, () => undefined]);

    expect(runtimes).toEqual([{ Player, version: '3.3.1' }]);
    expect(chunks.push).toBe(webpackPush);
  });
});
