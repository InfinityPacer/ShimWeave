import type { MediaSourceProvider } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { resolveMediaSource } from './media-source-provider.js';

interface TestContext {
  kind: string;
}

const provider = (id: string, kind: string): MediaSourceProvider<TestContext> => ({
  id,
  resolve: (context) =>
    context.kind === kind
      ? {
          sourceId: `${id}-source`,
          access: { kind: 'direct-http-range', url: `https://${id}.example/media` },
          nativePlaybackUrl: `https://${id}.example/media`,
        }
      : undefined,
});

describe('resolveMediaSource', () => {
  it('没有 provider 认领时保持未接管', () => {
    expect(resolveMediaSource({ kind: 'native' }, [provider('legacy', 'redirect')])).toEqual({
      status: 'unclaimed',
    });
  });

  it('仅返回唯一 provider 的媒体源', () => {
    expect(resolveMediaSource({ kind: 'redirect' }, [provider('legacy', 'redirect')])).toEqual({
      status: 'claimed',
      providerId: 'legacy',
      source: {
        sourceId: 'legacy-source',
        access: { kind: 'direct-http-range', url: 'https://legacy.example/media' },
        nativePlaybackUrl: 'https://legacy.example/media',
      },
    });
  });

  it('多个 provider 同时认领时不按注册顺序选择', () => {
    expect(
      resolveMediaSource({ kind: 'redirect' }, [
        provider('legacy', 'redirect'),
        provider('control', 'redirect'),
      ]),
    ).toEqual({ status: 'conflict', providerIds: ['legacy', 'control'] });
  });
});
