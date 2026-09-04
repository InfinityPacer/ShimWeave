import type { SiteAdapterManifest } from '@shimweave/contracts';

export type SiteAdapterResolution =
  | { readonly kind: 'matched'; readonly manifest: SiteAdapterManifest }
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'conflict'; readonly adapterIds: readonly string[] };

/** 文档从 URL 候选到 DNR 已生效的单向激活阶段；失败只回滚到 watcher-ready。 */
export type SiteAdapterPhase = 'prepared' | 'watcher-ready' | 'activating' | 'active';

export interface SiteAdapterBinding {
  readonly tabId: number;
  readonly adapterId: string;
  readonly url: string;
  readonly documentId: string;
  readonly phase: SiteAdapterPhase;
  readonly suspended: boolean;
}

interface PendingNavigation {
  readonly url: string;
}

/**
 * 注册器只裁决 URL 归属，不加载站点代码。多个 adapter 同时命中时拒绝激活，避免站点私有
 * Hook 在同一页面竞争。
 */
export class SiteAdapterRegistry {
  private readonly manifests: readonly SiteAdapterManifest[];

  constructor(manifests: readonly SiteAdapterManifest[]) {
    const ids = new Set<string>();
    for (const manifest of manifests) {
      if (!manifest.id.trim() || ids.has(manifest.id)) {
        throw new TypeError(`Invalid or duplicate site adapter id: ${manifest.id}`);
      }
      if (manifest.matchPatterns.length === 0) {
        throw new TypeError(`Site adapter ${manifest.id} has no match patterns`);
      }
      ids.add(manifest.id);
    }
    this.manifests = [...manifests];
  }

  get matchPatterns(): readonly string[] {
    return [...new Set(this.manifests.flatMap((manifest) => manifest.matchPatterns))];
  }

  matches(adapterId: string, rawUrl: string): boolean {
    const manifest = this.manifests.find((candidate) => candidate.id === adapterId);
    if (!manifest) return false;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    return manifest.matchPatterns.some((pattern) => matchesChromePattern(url, pattern));
  }

  matchingAdapterIds(rawUrl: string): readonly string[] {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return [];
    }
    return this.manifests
      .filter((manifest) =>
        manifest.matchPatterns.some((pattern) => matchesChromePattern(url, pattern)),
      )
      .map((manifest) => manifest.id)
      .sort();
  }

  resolve(rawUrl: string): SiteAdapterResolution {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { kind: 'unmatched' };
    }
    const matches = this.manifests.filter((manifest) =>
      manifest.matchPatterns.some((pattern) => matchesChromePattern(url, pattern)),
    );
    if (matches.length === 0) return { kind: 'unmatched' };
    if (matches.length === 1)
      return { kind: 'matched', manifest: matches[0] as SiteAdapterManifest };
    return {
      kind: 'conflict',
      adapterIds: matches.map((manifest) => manifest.id).sort(),
    };
  }
}

/**
 * 绑定状态以已提交 documentId 为权限边界。顶层导航开始时仅暂停旧文档，提交后才替换绑定；
 * 导航失败则恢复仍可见的旧文档，避免 tabId 复用造成跨文档接管。
 */
export class SiteAdapterBindings {
  private readonly bindings = new Map<number, SiteAdapterBinding>();
  private readonly pendingNavigations = new Map<number, PendingNavigation>();

  constructor(private readonly registry: SiteAdapterRegistry) {}

  beginNavigation(tabId: number, url: string): void {
    this.pendingNavigations.set(tabId, { url });
    const binding = this.bindings.get(tabId);
    if (binding && !binding.suspended) this.bindings.set(tabId, { ...binding, suspended: true });
  }

  failNavigation(tabId: number, url: string): boolean {
    const pending = this.pendingNavigations.get(tabId);
    if (!pending || pending.url !== url) return false;
    this.pendingNavigations.delete(tabId);
    const binding = this.bindings.get(tabId);
    if (!binding?.suspended) return false;
    this.bindings.set(tabId, { ...binding, suspended: false });
    return true;
  }

  commit(tabId: number, url: string, documentId: string): SiteAdapterBinding | undefined {
    this.pendingNavigations.delete(tabId);
    const current = this.bindings.get(tabId);
    if (current?.documentId === documentId && this.registry.matches(current.adapterId, url)) {
      const binding = { ...current, url, suspended: false };
      this.bindings.set(tabId, binding);
      return binding;
    }
    const resolved = this.registry.resolve(url);
    if (resolved.kind !== 'matched') {
      this.bindings.delete(tabId);
      return undefined;
    }
    const binding: SiteAdapterBinding = {
      tabId,
      adapterId: resolved.manifest.id,
      url,
      documentId,
      phase: 'prepared',
      suspended: false,
    };
    this.bindings.set(tabId, binding);
    return binding;
  }

  /** URL 候选冲突时，由已经完成站点私有识别的 adapter 竞争当前文档的唯一绑定。 */
  prepareCandidate(
    tabId: number,
    adapterId: string,
    url: string,
    documentId: string,
  ): SiteAdapterBinding | undefined {
    if (!this.registry.matches(adapterId, url)) return undefined;
    const current = this.bindings.get(tabId);
    if (current) {
      return current.adapterId === adapterId && current.documentId === documentId
        ? current
        : undefined;
    }
    const binding: SiteAdapterBinding = {
      tabId,
      adapterId,
      url,
      documentId,
      phase: 'prepared',
      suspended: false,
    };
    this.bindings.set(tabId, binding);
    return binding;
  }

  updateSameDocument(
    tabId: number,
    url: string,
    documentId: string,
  ): SiteAdapterBinding | undefined {
    const current = this.bindings.get(tabId);
    if (!current || current.documentId !== documentId) return undefined;
    if (!this.registry.matches(current.adapterId, url)) {
      this.bindings.delete(tabId);
      return undefined;
    }
    const binding = { ...current, url };
    this.bindings.set(tabId, binding);
    return binding;
  }

  watcherReady(
    tabId: number,
    adapterId: string,
    url: string,
    documentId: string,
  ): SiteAdapterBinding | undefined {
    const current = this.bindings.get(tabId);
    if (!this.matchesDocument(current, adapterId, url, documentId) || current.suspended) {
      return undefined;
    }
    if (current.phase === 'active' || current.phase === 'activating') return current;
    const binding = { ...current, phase: 'watcher-ready' as const };
    this.bindings.set(tabId, binding);
    return binding;
  }

  beginActivation(tabId: number, adapterId: string, documentId: string): boolean {
    const current = this.bindings.get(tabId);
    if (
      !current ||
      current.adapterId !== adapterId ||
      current.documentId !== documentId ||
      current.suspended ||
      current.phase !== 'watcher-ready'
    ) {
      return false;
    }
    this.bindings.set(tabId, { ...current, phase: 'activating' });
    return true;
  }

  completeActivation(tabId: number, adapterId: string, documentId: string): boolean {
    const current = this.bindings.get(tabId);
    if (
      !current ||
      current.adapterId !== adapterId ||
      current.documentId !== documentId ||
      current.suspended ||
      current.phase !== 'activating'
    ) {
      return false;
    }
    this.bindings.set(tabId, { ...current, phase: 'active' });
    return true;
  }

  rollbackActivation(tabId: number, adapterId: string, documentId: string): boolean {
    const current = this.bindings.get(tabId);
    if (
      !current ||
      current.adapterId !== adapterId ||
      current.documentId !== documentId ||
      current.phase !== 'activating'
    ) {
      return false;
    }
    this.bindings.set(tabId, { ...current, phase: 'watcher-ready' });
    return true;
  }

  revoke(tabId: number): boolean {
    this.pendingNavigations.delete(tabId);
    return this.bindings.delete(tabId);
  }

  get(tabId: number): SiteAdapterBinding | undefined {
    return this.bindings.get(tabId);
  }

  accepts(tabId: number, adapterId: string, documentId?: string, senderUrl?: string): boolean {
    const binding = this.bindings.get(tabId);
    if (
      binding?.phase !== 'active' ||
      binding.suspended ||
      binding.adapterId !== adapterId ||
      binding.documentId !== documentId
    ) {
      return false;
    }
    if (senderUrl && !this.registry.matches(adapterId, senderUrl)) return false;
    return true;
  }

  /**
   * webRequest 的 documentId 在部分请求阶段是可选字段；缺失时只能在已激活且未发生导航的
   * 文档中，以请求发起 origin 与页面 origin 一致作为降级边界。
   */
  acceptsNetworkRequest(
    tabId: number,
    adapterId: string,
    documentId?: string,
    initiator?: string,
  ): boolean {
    const binding = this.bindings.get(tabId);
    if (binding?.phase !== 'active' || binding.suspended || binding.adapterId !== adapterId) {
      return false;
    }
    if (documentId) return binding.documentId === documentId;
    if (!initiator) return false;
    try {
      return new URL(binding.url).origin === new URL(initiator).origin;
    } catch {
      return false;
    }
  }

  ruleTabIds(adapterId: string): readonly number[] {
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.adapterId === adapterId &&
          !binding.suspended &&
          (binding.phase === 'activating' || binding.phase === 'active'),
      )
      .map((binding) => binding.tabId)
      .sort((left, right) => left - right);
  }

  activeTabIds(adapterId: string): readonly number[] {
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.adapterId === adapterId && !binding.suspended && binding.phase === 'active',
      )
      .map((binding) => binding.tabId)
      .sort((left, right) => left - right);
  }

  get size(): number {
    return this.bindings.size;
  }

  private matchesDocument(
    binding: SiteAdapterBinding | undefined,
    adapterId: string,
    url: string,
    documentId: string,
  ): binding is SiteAdapterBinding {
    if (!binding || binding.adapterId !== adapterId || binding.documentId !== documentId) {
      return false;
    }
    return this.registry.matches(adapterId, url);
  }
}

const matchesChromePattern = (url: URL, pattern: string): boolean => {
  if (pattern === '<all_urls>') return url.protocol === 'http:' || url.protocol === 'https:';
  const match = /^(\*|http|https):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!match) return false;
  const [, scheme, hostPattern, pathPattern] = match;
  if (scheme !== '*' && `${scheme}:` !== url.protocol) return false;
  if (scheme === '*' && url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!matchesHost(url.hostname, hostPattern as string)) return false;
  return wildcardRegex(pathPattern as string).test(`${url.pathname}${url.search}`);
};

const matchesHost = (hostname: string, pattern: string): boolean => {
  if (pattern === '*') return true;
  if (!pattern.startsWith('*.')) return hostname === pattern;
  const base = pattern.slice(2);
  return hostname === base || hostname.endsWith(`.${base}`);
};

const wildcardRegex = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
