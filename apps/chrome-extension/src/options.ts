import type { AudioFallbackPolicy } from '@shimweave/contracts';
import { readSettings, writeSettings } from './extension-settings.js';

const form = document.querySelector<HTMLFormElement>('#settings');
const status = document.querySelector<HTMLElement>('#status');

/** 选项改动立即保存，下一次开始播放时生效。 */
const start = async (): Promise<void> => {
  if (!form || !status) return;
  const settings = await readSettings();
  const current = form.querySelector<HTMLInputElement>(
    `input[name="audioFallback"][value="${settings.audioFallback}"]`,
  );
  if (current) current.checked = true;
  form.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'audioFallback') return;
    void writeSettings({ audioFallback: input.value as AudioFallbackPolicy }).then(
      () => {
        status.textContent = '已保存，下次开始播放时生效';
      },
      () => {
        status.textContent = '没有保存成功，请重试';
      },
    );
  });
};

void start();
