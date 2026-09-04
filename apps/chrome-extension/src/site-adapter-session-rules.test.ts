import { describe, expect, it } from 'vitest';
import { SiteAdapterBindings, SiteAdapterRegistry } from './site-adapter-runtime.js';
import { plexControlSessionRule, SiteAdapterSessionRules } from './site-adapter-session-rules.js';

describe('SiteAdapterSessionRules', () => {
  const readyToActivate = (
    bindings: SiteAdapterBindings,
    tabId: number,
    url: string,
    documentId: string,
  ): void => {
    bindings.commit(tabId, url, documentId);
    bindings.watcherReady(tabId, 'plex', url, documentId);
    bindings.beginActivation(tabId, 'plex', documentId);
  };

  it('仅把 DNR 请求头规则绑定到 watcher 已就绪且正在激活的 Plex 标签页', async () => {
    const bindings = new SiteAdapterBindings(
      new SiteAdapterRegistry([
        {
          id: 'plex',
          displayName: 'Plex Web',
          matchPatterns: ['https://*/web/*'],
        },
      ]),
    );
    bindings.commit(6, 'https://prepared.example/web/index.html', 'doc-0');
    readyToActivate(bindings, 4, 'https://one.example/web/index.html', 'doc-1');
    readyToActivate(bindings, 2, 'https://two.example/web/index.html', 'doc-2');
    const updates: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];
    const rules = new SiteAdapterSessionRules(bindings, [plexControlSessionRule], (options) => {
      updates.push(options);
      return Promise.resolve();
    });

    await rules.sync();
    expect(updates[0]?.removeRuleIds).toEqual([1]);
    expect(updates[0]?.addRules?.[0]?.condition.tabIds).toEqual([2, 4]);

    bindings.revoke(2);
    bindings.revoke(4);
    await rules.sync();
    expect(updates[1]).toEqual({ removeRuleIds: [1], addRules: [] });
  });

  it('串行更新并以执行时的最新绑定为准', async () => {
    const bindings = new SiteAdapterBindings(
      new SiteAdapterRegistry([
        {
          id: 'plex',
          displayName: 'Plex Web',
          matchPatterns: ['https://*/web/*'],
        },
      ]),
    );
    const snapshots: number[][] = [];
    let releaseFirst: (() => void) | undefined;
    const rules = new SiteAdapterSessionRules(
      bindings,
      [plexControlSessionRule],
      async (options) => {
        snapshots.push(options.addRules?.[0]?.condition.tabIds ?? []);
        if (snapshots.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      },
    );

    readyToActivate(bindings, 1, 'https://one.example/web/index.html', 'doc-1');
    const first = rules.sync();
    await Promise.resolve();
    readyToActivate(bindings, 2, 'https://two.example/web/index.html', 'doc-2');
    const second = rules.sync();
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(snapshots).toEqual([[1], [1, 2]]);
  });

  it('拒绝重复或非法 ruleId，避免不同 adapter 覆盖彼此规则', () => {
    const bindings = new SiteAdapterBindings(new SiteAdapterRegistry([]));
    const update = () => Promise.resolve();

    expect(
      () =>
        new SiteAdapterSessionRules(
          bindings,
          [plexControlSessionRule, { ...plexControlSessionRule }],
          update,
        ),
    ).toThrow(/duplicate/);
    expect(
      () =>
        new SiteAdapterSessionRules(bindings, [{ ...plexControlSessionRule, ruleId: 0 }], update),
    ).toThrow(/Invalid/);
  });
});
