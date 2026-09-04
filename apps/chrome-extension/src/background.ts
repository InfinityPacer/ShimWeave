import {
  type PlexMediaSourceNotice,
  type PlexRequestStartedNotice,
  parsePlexControlResponse,
  parsePlexMediaRedirect,
  parsePlexRequestStarted,
  parsePlexTimelineContext,
  plexAdapterManifest,
} from '@shimweave/adapter-plex';
import { PlexTimelineDispatcher } from './plex-timeline-dispatcher.js';
import { isPlexTimelineMessage, PLEX_TIMELINE_RELEASE_MESSAGE } from './plex-timeline-protocol.js';
import { PlexTimelineSessionStore } from './plex-timeline-session-store.js';
import {
  isSiteAdapterActivateMessage,
  SITE_ADAPTER_REACTIVATE_MESSAGE,
} from './site-adapter-protocol.js';
import { SiteAdapterBindings, SiteAdapterRegistry } from './site-adapter-runtime.js';
import { plexControlSessionRule, SiteAdapterSessionRules } from './site-adapter-session-rules.js';

const PLEX_ADAPTER_ID = plexAdapterManifest.id;
const adapterRegistry = new SiteAdapterRegistry([plexAdapterManifest]);
const adapterBindings = new SiteAdapterBindings(adapterRegistry);
const adapterSessionRules = new SiteAdapterSessionRules(
  adapterBindings,
  [plexControlSessionRule],
  (options) => chrome.declarativeNetRequest.updateSessionRules(options),
);

const plexStartRequestFilter: chrome.webRequest.RequestFilter = {
  urls: ['*://*/video/:/transcode/universal/start.mpd*'],
  types: ['xmlhttprequest', 'media', 'other'],
};

const pendingTimelineContexts = new Map<
  string,
  {
    tabId: number;
    frameId: number;
    pageOrigin: string;
    context: NonNullable<ReturnType<typeof parsePlexTimelineContext>>;
  }
>();
const timelineSessionStore = new PlexTimelineSessionStore(chrome.storage.session);
const timelineDispatcher = new PlexTimelineDispatcher({
  onRegistered: (reportId, binding) => timelineSessionStore.save(reportId, binding),
  onDeleted: (reportId) => timelineSessionStore.remove(reportId),
});
const timelineRestoreTasks = new Map<string, Promise<void>>();
const claimedMediaRequests = new Map<string, number>();

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTabRequestState(details.tabId);
  adapterBindings.beginNavigation(details.tabId, details.url);
  scheduleAdapterRuleSync();
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  adapterBindings.commit(details.tabId, details.url, details.documentId);
  scheduleAdapterRuleSync();
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (adapterBindings.failNavigation(details.tabId, details.url)) scheduleAdapterRuleSync();
});

const updateSameDocumentBinding = (details: {
  tabId: number;
  frameId: number;
  url: string;
  documentId: string;
}): void => {
  if (details.frameId !== 0) return;
  adapterBindings.updateSameDocument(details.tabId, details.url, details.documentId);
  scheduleAdapterRuleSync();
};
chrome.webNavigation.onHistoryStateUpdated.addListener(updateSameDocumentBinding);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(updateSameDocumentBinding);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabRequestState(tabId);
  if (adapterBindings.revoke(tabId)) scheduleAdapterRuleSync();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  clearTabRequestState(removedTabId);
  adapterBindings.revoke(removedTabId);
  void restoreReplacedTab(addedTabId);
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isActivePlexRequest(details)) return;
  const context = parsePlexTimelineContext(details.url);
  if (context) {
    pendingTimelineContexts.set(details.requestId, {
      tabId: details.tabId,
      frameId: details.frameId,
      pageOrigin: pageOrigin(details.initiator) ?? context.origin,
      context,
    });
  }
  const notice = parsePlexRequestStarted(details.url, details.requestId);
  if (notice) notifyTab(details.tabId, notice);
}, plexStartRequestFilter);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isSiteAdapterActivateMessage(message)) {
    void activateSiteAdapter(message.adapterId, sender).then(
      (activated) =>
        sendResponse({ activated, adapterId: activated ? message.adapterId : undefined }),
      () => sendResponse({ activated: false }),
    );
    return true;
  }
  if (isPlexTimelineMessage(message)) {
    void handleTimelineMessage(message, sender).then(sendResponse, () => sendResponse(false));
    return true;
  }
  if (typeof message !== 'object' || message === null || !('type' in message)) return false;
  if (message.type !== 'shimweave:health') return false;

  sendResponse({
    ok: true,
    runtime: 'chromium-mv3',
    timeline: timelineDispatcher.diagnostics,
    pendingTimelineContexts: pendingTimelineContexts.size,
    boundAdapterDocuments: adapterBindings.size,
    activeAdapters: adapterBindings.activeTabIds(PLEX_ADAPTER_ID).length,
    activePlexTabs: adapterBindings.activeTabIds(PLEX_ADAPTER_ID).length,
  });
  return false;
});

chrome.webRequest.onBeforeRedirect.addListener((details) => {
  if (!isActivePlexRequest(details)) return;
  if (claimedMediaRequests.has(details.requestId)) return;
  const notice = parsePlexMediaRedirect(details.url, details.redirectUrl, details.requestId);
  if (!notice) return;
  claimedMediaRequests.set(details.requestId, details.tabId);
  notifyTab(details.tabId, withTimelineReport(notice, details.requestId));
}, plexStartRequestFilter);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!isActivePlexRequest(details)) return;
    if (claimedMediaRequests.has(details.requestId)) return;
    const notice = parsePlexControlResponse(
      details.url,
      details.statusCode,
      details.responseHeaders,
      details.requestId,
    );
    if (!notice) return;
    claimedMediaRequests.set(details.requestId, details.tabId);
    notifyTab(details.tabId, withTimelineReport(notice, details.requestId));
  },
  plexStartRequestFilter,
  ['responseHeaders'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => clearRequestState(details.requestId),
  plexStartRequestFilter,
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => clearRequestState(details.requestId),
  plexStartRequestFilter,
);

const withTimelineReport = (
  notice: PlexMediaSourceNotice,
  requestId: string,
): PlexMediaSourceNotice => {
  const pending = pendingTimelineContexts.get(requestId);
  pendingTimelineContexts.delete(requestId);
  if (!pending) return notice;
  const playbackReportId = crypto.randomUUID();
  timelineDispatcher.register(playbackReportId, pending);
  return { ...notice, playbackReportId };
};

const clearRequestState = (requestId: string): void => {
  pendingTimelineContexts.delete(requestId);
  claimedMediaRequests.delete(requestId);
};

const clearTabRequestState = (tabId: number): void => {
  for (const [requestId, pending] of pendingTimelineContexts) {
    if (pending.tabId === tabId) pendingTimelineContexts.delete(requestId);
  }
  for (const [requestId, ownerTabId] of claimedMediaRequests) {
    if (ownerTabId === tabId) claimedMediaRequests.delete(requestId);
  }
};

const pageOrigin = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const handleTimelineMessage = async (
  message: Parameters<PlexTimelineDispatcher['dispatch']>[0],
  sender: chrome.runtime.MessageSender,
): Promise<boolean> => {
  if (!acceptsPlexSender(sender)) return false;
  await restoreTimelineBinding(message.reportId);
  const accepted = await timelineDispatcher.dispatch(message, {
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    pageOrigin: pageOrigin(sender.url),
  });
  const releasesBinding =
    message.type === PLEX_TIMELINE_RELEASE_MESSAGE ? true : message.release === true;
  if (accepted && releasesBinding) {
    await timelineSessionStore.remove(message.reportId).catch(() => undefined);
  }
  return accepted;
};

const activateSiteAdapter = async (
  adapterId: string,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> => {
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  const senderUrl = sender.url;
  if (tabId === undefined || !documentId || !senderUrl) return false;
  const frame = await readCurrentTopFrame(tabId);
  if (!frame?.documentId || frame.documentId !== documentId) return false;
  const current = adapterBindings.get(tabId);
  if (current && current.documentId !== documentId) return false;
  if (!current && !adapterBindings.prepareCandidate(tabId, adapterId, frame.url, documentId)) {
    return false;
  }
  const ready = adapterBindings.watcherReady(tabId, adapterId, senderUrl, documentId);
  if (!ready) return false;
  if (ready.phase === 'active') return true;
  if (!adapterBindings.beginActivation(tabId, adapterId, documentId)) return false;
  try {
    await adapterSessionRules.sync();
  } catch {
    adapterBindings.rollbackActivation(tabId, adapterId, documentId);
    scheduleAdapterRuleSync();
    return false;
  }
  const verifiedFrame = await readCurrentTopFrame(tabId);
  if (
    !verifiedFrame?.documentId ||
    verifiedFrame.documentId !== documentId ||
    !adapterBindings.completeActivation(tabId, adapterId, documentId)
  ) {
    adapterBindings.rollbackActivation(tabId, adapterId, documentId);
    scheduleAdapterRuleSync();
    return false;
  }
  return adapterBindings.accepts(tabId, adapterId, documentId, senderUrl);
};

const acceptsPlexSender = (sender: chrome.runtime.MessageSender): boolean => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  return adapterBindings.accepts(tabId, PLEX_ADAPTER_ID, sender.documentId, sender.url);
};

const isActivePlexRequest = (details: {
  tabId: number;
  frameId: number;
  documentId?: string | undefined;
  initiator?: string | undefined;
}): boolean =>
  details.tabId >= 0 &&
  details.frameId === 0 &&
  adapterBindings.acceptsNetworkRequest(
    details.tabId,
    PLEX_ADAPTER_ID,
    details.documentId,
    details.initiator,
  );

let adapterRuleRetryTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_ADAPTER_RULE_RETRIES = 5;

/** DNR 更新失败时保留期望状态并退避重试；下一次导航或握手始终以最新绑定重新收敛。 */
const scheduleAdapterRuleSync = (retryAttempt = 0): void => {
  void adapterSessionRules.sync().then(
    () => {
      if (adapterRuleRetryTimer) clearTimeout(adapterRuleRetryTimer);
      adapterRuleRetryTimer = undefined;
    },
    () => {
      if (adapterRuleRetryTimer || retryAttempt >= MAX_ADAPTER_RULE_RETRIES) return;
      const delayMs = Math.min(250 * 2 ** retryAttempt, 4_000);
      adapterRuleRetryTimer = setTimeout(() => {
        adapterRuleRetryTimer = undefined;
        scheduleAdapterRuleSync(retryAttempt + 1);
      }, delayMs);
    },
  );
};

const restoreTimelineBinding = async (reportId: string): Promise<void> => {
  if (timelineDispatcher.has(reportId)) return;
  const existing = timelineRestoreTasks.get(reportId);
  if (existing) return existing;
  const task = timelineSessionStore
    .load(reportId)
    .then((stored) => {
      if (!stored || timelineDispatcher.has(reportId)) return;
      timelineDispatcher.restore(reportId, stored.binding, stored.lastUsedAt);
    })
    .finally(() => timelineRestoreTasks.delete(reportId));
  timelineRestoreTasks.set(reportId, task);
  return task;
};

const notifyTab = (
  tabId: number,
  notice: PlexMediaSourceNotice | PlexRequestStartedNotice,
): void => {
  const binding = adapterBindings.get(tabId);
  if (binding?.adapterId !== PLEX_ADAPTER_ID || binding.phase !== 'active' || binding.suspended) {
    return;
  }
  chrome.tabs.sendMessage(tabId, notice, { documentId: binding.documentId }, () => {
    void chrome.runtime.lastError;
  });
};

const restoreOpenTabBindings = async (): Promise<void> => {
  const tabs = await chrome.tabs.query({ url: [...adapterRegistry.matchPatterns] });
  const restored = await Promise.allSettled(
    tabs.flatMap((tab) => (tab.id === undefined ? [] : [restoreOpenTabBinding(tab.id)])),
  );
  await adapterSessionRules.sync();
  for (const result of restored) {
    if (result.status === 'fulfilled' && result.value) requestTabReactivation(result.value);
  }
};

const restoreOpenTabBinding = async (tabId: number) => {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!frame) {
    adapterBindings.revoke(tabId);
    return undefined;
  }
  if (!frame.documentId) {
    adapterBindings.revoke(tabId);
    return undefined;
  }
  const adapterIds = adapterRegistry.matchingAdapterIds(frame.url);
  if (adapterIds.length === 0) {
    adapterBindings.revoke(tabId);
    return undefined;
  }
  adapterBindings.commit(tabId, frame.url, frame.documentId);
  return { tabId, documentId: frame.documentId, adapterIds };
};

const restoreReplacedTab = async (tabId: number): Promise<void> => {
  const binding = await restoreOpenTabBinding(tabId).catch(() => undefined);
  await adapterSessionRules.sync().catch(() => {
    scheduleAdapterRuleSync();
  });
  if (binding) requestTabReactivation(binding);
};

const requestTabReactivation = (document: {
  readonly tabId: number;
  readonly documentId: string;
  readonly adapterIds: readonly string[];
}) => {
  for (const adapterId of document.adapterIds) {
    chrome.tabs.sendMessage(
      document.tabId,
      { type: SITE_ADAPTER_REACTIVATE_MESSAGE, adapterId },
      { documentId: document.documentId },
      () => {
        void chrome.runtime.lastError;
      },
    );
  }
};

const readCurrentTopFrame = async (tabId: number) =>
  chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);

void restoreOpenTabBindings().catch(() => scheduleAdapterRuleSync());
