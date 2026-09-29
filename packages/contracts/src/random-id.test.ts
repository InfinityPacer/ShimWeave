import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random-id.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns distinct v4 UUID strings', () => {
    const ids = new Set(Array.from({ length: 256 }, () => randomId()));
    expect(ids.size).toBe(256);
    for (const id of ids) expect(id).toMatch(V4);
  });

  // http 打开的 Plex Web 不是安全上下文，crypto 上只有 getRandomValues。
  it('works where crypto.randomUUID is unavailable', () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) => original.getRandomValues(array),
    });
    expect('randomUUID' in globalThis.crypto).toBe(false);
    expect(randomId()).toMatch(V4);
  });
});
