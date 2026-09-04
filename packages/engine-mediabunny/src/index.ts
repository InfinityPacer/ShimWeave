import type { MediaEngineProvider } from '@shimweave/contracts';
import { MediabunnyMediaSession } from './media-session.js';

export { ensureAudioCodecSupport } from './codec-support.js';
export {
  MediabunnyConversionUnsupportedError,
  MediabunnySeekOutOfRangeError,
} from './fragment-stream.js';
export {
  MediabunnyMediaSession,
  MediabunnyMediaSessionClosedError,
} from './media-session.js';
export type { MediabunnyByteSourceAdapterOptions } from './source-adapter.js';
export {
  MediabunnyByteSourceAdapter,
  MediabunnySourceDisposedError,
  MediabunnySourceReadError,
} from './source-adapter.js';

/** 默认引擎通过公开 SPI 注册，浏览器宿主无需依赖 Mediabunny 会话类型。 */
export const mediabunnyMediaEngine = {
  createSession: (source) => new MediabunnyMediaSession(source),
} satisfies MediaEngineProvider;
