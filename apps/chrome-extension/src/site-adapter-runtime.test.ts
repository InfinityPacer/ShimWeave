import type { SiteAdapterManifest } from '@shimweave/contracts';
import { describe, expect, it } from 'vitest';
import { SiteAdapterBindings, SiteAdapterRegistry } from './site-adapter-runtime.js';

const plex: SiteAdapterManifest = {
  id: 'plex',
  displayName: 'Plex Web',
  matchPatterns: ['http://*/web/*', 'https://*/web/*'],
};

const activate = (
  bindings: SiteAdapterBindings,
  tabId: number,
  url: string,
  documentId: string,
): void => {
  bindings.commit(tabId, url, documentId);
  expect(bindings.watcherReady(tabId, 'plex', url, documentId)?.phase).toBe('watcher-ready');
  expect(bindings.beginActivation(tabId, 'plex', documentId)).toBe(true);
  expect(bindings.completeActivation(tabId, 'plex', documentId)).toBe(true);
};

describe('SiteAdapterRegistry', () => {
  it('按 Chrome match pattern 匹配任意端口的 Plex Web 页面', () => {
    const registry = new SiteAdapterRegistry([plex]);

    expect(registry.resolve('https://media.example:20600/web/index.html#!/media')).toEqual({
      kind: 'matched',
      manifest: plex,
    });
    expect(registry.resolve('https://media.example/library/metadata/1')).toEqual({
      kind: 'unmatched',
    });
  });

  it('拒绝重复注册及同一 URL 的多适配器竞争', () => {
    expect(() => new SiteAdapterRegistry([plex, plex])).toThrow(/duplicate/);
    const registry = new SiteAdapterRegistry([
      plex,
      {
        id: 'other',
        displayName: 'Other',
        matchPatterns: ['https://*/web/*'],
      },
    ]);

    expect(registry.resolve('https://media.example/web/index.html')).toEqual({
      kind: 'conflict',
      adapterIds: ['other', 'plex'],
    });
    expect(registry.matches('plex', 'https://media.example/web/index.html')).toBe(true);
    expect(registry.matches('missing', 'https://media.example/web/index.html')).toBe(false);
    expect(registry.matchingAdapterIds('https://media.example/web/index.html')).toEqual([
      'other',
      'plex',
    ]);
  });
});

describe('SiteAdapterBindings', () => {
  it('只有 watcher 就绪并完成 DNR 激活后才接受当前文档', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const url = 'https://media.example/web/index.html';
    bindings.commit(7, url, 'document-new');

    expect(bindings.activeTabIds('plex')).toEqual([]);
    expect(bindings.ruleTabIds('plex')).toEqual([]);
    expect(bindings.accepts(7, 'plex', 'document-new', url)).toBe(false);

    expect(bindings.watcherReady(7, 'plex', url, 'document-new')?.phase).toBe('watcher-ready');
    expect(bindings.beginActivation(7, 'plex', 'document-new')).toBe(true);
    expect(bindings.ruleTabIds('plex')).toEqual([7]);
    expect(bindings.activeTabIds('plex')).toEqual([]);

    expect(bindings.completeActivation(7, 'plex', 'document-new')).toBe(true);
    expect(bindings.activeTabIds('plex')).toEqual([7]);
    expect(bindings.accepts(7, 'plex', 'document-new', url)).toBe(true);
  });

  it('拒绝迟到的旧文档重新激活当前标签页', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const url = 'https://media.example/web/index.html';
    bindings.commit(7, url, 'document-old');
    bindings.beginNavigation(7, url);
    bindings.commit(7, url, 'document-new');

    expect(bindings.watcherReady(7, 'plex', url, 'document-old')).toBeUndefined();
    expect(bindings.beginActivation(7, 'plex', 'document-old')).toBe(false);
    expect(bindings.get(7)?.documentId).toBe('document-new');
    expect(bindings.get(7)?.phase).toBe('prepared');
  });

  it('URL 候选重叠时只允许完成私有识别的 adapter 认领文档', () => {
    const registry = new SiteAdapterRegistry([
      plex,
      {
        id: 'emby',
        displayName: 'Emby Web',
        matchPatterns: ['https://*/web/*'],
      },
    ]);
    const bindings = new SiteAdapterBindings(registry);
    const url = 'https://media.example/web/index.html';

    expect(bindings.commit(13, url, 'document-1')).toBeUndefined();
    expect(bindings.prepareCandidate(13, 'plex', url, 'document-1')?.adapterId).toBe('plex');
    expect(bindings.prepareCandidate(13, 'emby', url, 'document-1')).toBeUndefined();
    expect(bindings.watcherReady(13, 'plex', url, 'document-1')?.phase).toBe('watcher-ready');
  });

  it('导航期间暂停 DNR，提交新文档后保持未激活', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const firstUrl = 'https://media.example/web/index.html';
    const secondUrl = 'https://media.example/web/desktop.html';
    activate(bindings, 8, firstUrl, 'document-1');

    bindings.beginNavigation(8, secondUrl);
    expect(bindings.activeTabIds('plex')).toEqual([]);
    expect(bindings.ruleTabIds('plex')).toEqual([]);
    expect(bindings.accepts(8, 'plex', 'document-1', firstUrl)).toBe(false);

    bindings.commit(8, secondUrl, 'document-2');
    expect(bindings.get(8)).toMatchObject({ documentId: 'document-2', phase: 'prepared' });
    expect(bindings.ruleTabIds('plex')).toEqual([]);
  });

  it('导航失败只恢复对应 pending 导航仍可见的旧文档', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const currentUrl = 'https://media.example/web/index.html';
    activate(bindings, 9, currentUrl, 'document-1');

    bindings.beginNavigation(9, 'https://media.example/web/first.html');
    bindings.beginNavigation(9, 'https://media.example/web/latest.html');
    expect(bindings.failNavigation(9, 'https://media.example/web/first.html')).toBe(false);
    expect(bindings.activeTabIds('plex')).toEqual([]);

    expect(bindings.failNavigation(9, 'https://media.example/web/latest.html')).toBe(true);
    expect(bindings.activeTabIds('plex')).toEqual([9]);
    expect(bindings.accepts(9, 'plex', 'document-1', currentUrl)).toBe(true);
  });

  it('同文档 History 导航保留 active 状态，跨文档提交不会继承', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const url = 'https://media.example/web/index.html';
    activate(bindings, 10, url, 'document-1');

    bindings.updateSameDocument(10, `${url}#!/details`, 'document-1');
    expect(bindings.get(10)?.phase).toBe('active');
    expect(bindings.activeTabIds('plex')).toEqual([10]);

    bindings.commit(10, `${url}?reload=1`, 'document-2');
    expect(bindings.get(10)?.phase).toBe('prepared');
    expect(bindings.activeTabIds('plex')).toEqual([]);
  });

  it('DNR 同步失败后可以回滚到 watcher-ready 再重试', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const url = 'https://media.example/web/index.html';
    bindings.commit(11, url, 'document-1');
    bindings.watcherReady(11, 'plex', url, 'document-1');
    bindings.beginActivation(11, 'plex', 'document-1');

    expect(bindings.rollbackActivation(11, 'plex', 'document-1')).toBe(true);
    expect(bindings.get(11)?.phase).toBe('watcher-ready');
    expect(bindings.ruleTabIds('plex')).toEqual([]);
    expect(bindings.beginActivation(11, 'plex', 'document-1')).toBe(true);
  });

  it('网络事件缺少 documentId 时仅允许同源 active 页面降级', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([plex]));
    const url = 'https://media.example/web/index.html';
    bindings.commit(12, url, 'document-1');
    expect(bindings.acceptsNetworkRequest(12, 'plex', undefined, 'https://media.example')).toBe(
      false,
    );

    activate(bindings, 12, url, 'document-1');
    expect(bindings.acceptsNetworkRequest(12, 'plex', 'document-1')).toBe(true);
    expect(bindings.acceptsNetworkRequest(12, 'plex', 'document-old')).toBe(false);
    expect(bindings.acceptsNetworkRequest(12, 'plex', undefined, 'https://media.example')).toBe(
      true,
    );
    expect(bindings.acceptsNetworkRequest(12, 'plex', undefined, 'https://other.example')).toBe(
      false,
    );
  });
});
