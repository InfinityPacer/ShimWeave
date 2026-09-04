import type { MediaSourceDescriptor, MediaSourceProvider } from '@shimweave/contracts';

export type MediaSourceResolution =
  | { status: 'unclaimed' }
  | { status: 'claimed'; providerId: string; source: MediaSourceDescriptor }
  | { status: 'conflict'; providerIds: readonly string[] };

/**
 * 一个观察结果只能由一个 provider 认领。冲突时不选择先后顺序，
 * 调用方应完整保留站点原始播放链路。
 */
export const resolveMediaSource = <TContext>(
  context: TContext,
  providers: readonly MediaSourceProvider<TContext>[],
): MediaSourceResolution => {
  const claims: { providerId: string; source: MediaSourceDescriptor }[] = [];
  for (const provider of providers) {
    const source = provider.resolve(context);
    if (source) claims.push({ providerId: provider.id, source });
  }
  if (claims.length === 0) return { status: 'unclaimed' };
  if (claims.length > 1) {
    return { status: 'conflict', providerIds: claims.map((claim) => claim.providerId) };
  }
  const claim = claims[0];
  if (!claim) return { status: 'unclaimed' };
  return { status: 'claimed', providerId: claim.providerId, source: claim.source };
};
