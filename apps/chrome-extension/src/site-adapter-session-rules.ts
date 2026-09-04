import type { SiteAdapterBindings } from './site-adapter-runtime.js';

export interface SiteAdapterSessionRuleSpec {
  readonly adapterId: string;
  readonly ruleId: number;
  create(tabIds: readonly number[]): chrome.declarativeNetRequest.Rule;
}

/** session rules 与当前标签绑定同步；每次更新原子替换，且并发导航严格串行。 */
export class SiteAdapterSessionRules {
  private tail = Promise.resolve();

  constructor(
    private readonly bindings: SiteAdapterBindings,
    private readonly specs: readonly SiteAdapterSessionRuleSpec[],
    private readonly update: typeof chrome.declarativeNetRequest.updateSessionRules,
  ) {
    const ruleIds = new Set<number>();
    for (const spec of specs) {
      if (!Number.isSafeInteger(spec.ruleId) || spec.ruleId <= 0 || ruleIds.has(spec.ruleId)) {
        throw new TypeError(`Invalid or duplicate site adapter session rule id: ${spec.ruleId}`);
      }
      ruleIds.add(spec.ruleId);
    }
  }

  sync(): Promise<void> {
    const task = this.tail.then(async () => {
      const addRules = this.specs.flatMap((spec) => {
        const tabIds = this.bindings.ruleTabIds(spec.adapterId);
        return tabIds.length > 0 ? [spec.create(tabIds)] : [];
      });
      await this.update({
        removeRuleIds: this.specs.map((spec) => spec.ruleId),
        addRules,
      });
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

export const plexControlSessionRule: SiteAdapterSessionRuleSpec = {
  adapterId: 'plex',
  ruleId: 1,
  create: (tabIds) => ({
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'X-ShimWeave-Accept',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: 'control-v1',
        },
      ],
    },
    condition: {
      regexFilter: '^https?://[^/]+/video/:/transcode/universal/start\\.mpd(?:\\?|$)',
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'media' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
      tabIds: [...tabIds],
    },
  }),
};
