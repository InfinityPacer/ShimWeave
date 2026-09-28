import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from './extension-settings.js';

const memoryArea = (initial: Record<string, unknown> = {}) => {
  const data = { ...initial };
  return {
    data,
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
};

describe('扩展设置', () => {
  it('没有保存过时使用默认值', async () => {
    expect(await readSettings(memoryArea() as never)).toEqual(DEFAULT_SETTINGS);
  });

  it('读回保存的取值，不认识的取值回到默认', async () => {
    const area = memoryArea();
    await writeSettings({ audioFallback: 'strict' }, area as never);
    expect(await readSettings(area as never)).toEqual({ audioFallback: 'strict' });
    expect(await readSettings(memoryArea({ audioFallback: 'maybe' }) as never)).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});
