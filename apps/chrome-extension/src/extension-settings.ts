import type { AudioFallbackPolicy } from '@shimweave/contracts';

/** 用户可调的扩展设置，保存在 chrome.storage.sync，随浏览器账号同步。 */
export interface ShimWeaveSettings {
  audioFallback: AudioFallbackPolicy;
}

export const DEFAULT_SETTINGS: Readonly<ShimWeaveSettings> = { audioFallback: 'compatible' };

type SettingsArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

/** 缺失或取值不认识时回到默认值，旧版本写下的数据不会让播放失败。 */
export const readSettings = async (
  area: SettingsArea = chrome.storage.sync,
): Promise<ShimWeaveSettings> => {
  const stored = (await area.get(Object.keys(DEFAULT_SETTINGS))) as Record<string, unknown>;
  return {
    audioFallback: isAudioFallback(stored.audioFallback)
      ? stored.audioFallback
      : DEFAULT_SETTINGS.audioFallback,
  };
};

export const writeSettings = (
  settings: Partial<ShimWeaveSettings>,
  area: SettingsArea = chrome.storage.sync,
): Promise<void> => area.set(settings);

const isAudioFallback = (value: unknown): value is AudioFallbackPolicy =>
  value === 'strict' || value === 'compatible';
