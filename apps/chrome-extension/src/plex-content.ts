import {
  isPlexMediaSourceNotice,
  isPlexNativeMessage,
  isPlexRequestStartedNotice,
  PLEX_NATIVE_PROTOCOL,
  type PlexNativeMessage,
  parsePlexTimelineSeconds,
  plexAdapterManifest,
} from '@shimweave/adapter-plex';
import { BrowserCapabilityRuntime, createBrowserCapabilityScope } from './capability-runtime.js';
import { BrowserPlaybackRuntime } from './playback-runtime.js';
import { PlexErrorPresenter } from './plex-error-presenter.js';
import { PlexNativePlaybackHost } from './plex-native-host.js';
import {
  PLEX_TIMELINE_RELEASE_MESSAGE,
  type PlexTimelineMessage,
} from './plex-timeline-protocol.js';
import { PlexTimelineReporter } from './plex-timeline-reporter.js';
import { SiteAdapterClientActivation } from './site-adapter-client-activation.js';
import {
  isSiteAdapterReactivateMessage,
  SITE_ADAPTER_ACTIVATE_MESSAGE,
  type SiteAdapterActivateResponse,
} from './site-adapter-protocol.js';

interface ActivePlexRuntime {
  dispose(): Promise<void>;
}

const activeRuntime = startPlexRuntime();

window.addEventListener(
  'pagehide',
  () => {
    void activeRuntime.dispose();
  },
  { once: true },
);

/** Plex 页面先建立消息与 Hook watcher，再请求后台为当前 document 启用 DNR。 */
function startPlexRuntime(): ActivePlexRuntime {
  let capabilityRuntime: BrowserCapabilityRuntime | undefined;
  const activation = new SiteAdapterClientActivation({ activate: requestActivation });
  const errorPresenter = new PlexErrorPresenter({ document });
  const postPageMessage = (message: PlexNativeMessage): void =>
    window.postMessage(message, location.origin);
  const host = new PlexNativePlaybackHost({
    createPlaybackRuntime: () => {
      capabilityRuntime ??= new BrowserCapabilityRuntime({
        scope: createBrowserCapabilityScope(),
      });
      void capabilityRuntime.pruneSamples();
      return new BrowserPlaybackRuntime({ capabilities: capabilityRuntime });
    },
    resolveMediaElement: (sessionId) =>
      Array.from(document.querySelectorAll<HTMLMediaElement>('video')).find(
        (element) => element.dataset.shimweaveNativeSession === sessionId,
      ),
    postMessage: postPageMessage,
    readStartSeconds: readPlexTimelineSeconds,
    createTimelineReporter: (notice) =>
      notice.playbackReportId
        ? new PlexTimelineReporter({ reportId: notice.playbackReportId, send: sendTimeline })
        : undefined,
    releaseNotice: (notice) => {
      if (!notice.playbackReportId) return;
      sendTimeline({
        type: PLEX_TIMELINE_RELEASE_MESSAGE,
        reportId: notice.playbackReportId,
      });
    },
    presentFailure: (failure, formats) => errorPresenter.arm(failure.code, formats),
  });

  const onRuntimeMessage = (message: unknown): false => {
    if (isSiteAdapterReactivateMessage(message) && message.adapterId === plexAdapterManifest.id) {
      activation.reactivate();
      return false;
    }
    if (isPlexRequestStartedNotice(message) || isPlexMediaSourceNotice(message)) {
      if (isPlexRequestStartedNotice(message)) errorPresenter.beginSource(message.sourceKey);
      host.acceptRuntimeMessage(message);
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  let watcherReady = false;
  const onPageMessage = (event: MessageEvent): void => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!isPlexNativeMessage(event.data) || event.data.sender !== 'main-hook') return;
    if (event.data.type === 'watcher-ready') {
      watcherReady = true;
      activation.watcherReady();
    }
    if (event.data.type === 'blocked-source-retry')
      errorPresenter.beginSource(event.data.sourceKey);
    host.acceptPageMessage(event.data);
  };
  window.addEventListener('message', onPageMessage);

  const announceHost = (): void => {
    postPageMessage({
      protocol: PLEX_NATIVE_PROTOCOL,
      sender: 'extension-host',
      type: 'host-ready',
    });
  };
  announceHost();
  let announcements = 1;
  const announceTimer = setInterval(() => {
    if (watcherReady || announcements >= 60) {
      clearInterval(announceTimer);
      return;
    }
    announcements += 1;
    announceHost();
  }, 250);

  return {
    dispose: async () => {
      activation.stop();
      clearInterval(announceTimer);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      window.removeEventListener('message', onPageMessage);
      errorPresenter.dispose();
      await host.dispose();
      capabilityRuntime?.close();
    },
  };
}

function requestActivation(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: SITE_ADAPTER_ACTIVATE_MESSAGE, adapterId: plexAdapterManifest.id },
      (response: SiteAdapterActivateResponse | undefined) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(response?.activated === true && response.adapterId === plexAdapterManifest.id);
      },
    );
  });
}

function sendTimeline(message: PlexTimelineMessage): void {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

/** Plex 的页面时间轴用于恢复起播位置；缺失或越界时从媒体开头开始。 */
function readPlexTimelineSeconds(): number | undefined {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('[role="slider"][aria-valuenow][aria-valuemax]'),
  );
  for (const slider of candidates.reverse()) {
    const seconds = parsePlexTimelineSeconds(
      slider.getAttribute('aria-valuenow'),
      slider.getAttribute('aria-valuemax'),
    );
    if (seconds !== undefined && Number(slider.getAttribute('aria-valuemax')) >= 60_000) {
      return seconds;
    }
  }
  return undefined;
}
