import {
  isPlexNativeMessage,
  PLEX_NATIVE_PROTOCOL,
  PlexNativeHookController,
  type PlexNativeMessage,
  PlexShakaRuntimeWatcher,
} from '@shimweave/adapter-plex';

const post = (message: PlexNativeMessage): void => window.postMessage(message, location.origin);
let runtime:
  | { readonly hook: PlexNativeHookController; readonly watcher: PlexShakaRuntimeWatcher }
  | undefined;

const activate = (): NonNullable<typeof runtime> => {
  if (runtime) return runtime;
  const hook = new PlexNativeHookController({ postMessage: post });
  let observed = false;
  const watcher = new PlexShakaRuntimeWatcher({
    host: window as unknown as Record<string, unknown>,
    onObserved: () => {
      if (observed) return;
      observed = true;
      post({
        protocol: PLEX_NATIVE_PROTOCOL,
        sender: 'main-hook',
        type: 'watcher-ready',
      });
    },
    onRuntime: (plexRuntime) => hook.install(plexRuntime),
  });
  runtime = { hook, watcher };
  watcher.start();
  return runtime;
};

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isPlexNativeMessage(event.data)) return;
  if (event.data.sender !== 'extension-host') return;
  if (event.data.type === 'host-ready') {
    activate();
    return;
  }
  runtime?.hook.accept(event.data);
});

window.addEventListener(
  'pagehide',
  () => {
    runtime?.watcher.stop();
    runtime?.hook.dispose();
    runtime = undefined;
  },
  { once: true },
);
