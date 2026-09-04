import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { plexControlSessionRule } from '../apps/chrome-extension/src/site-adapter-session-rules.js';
import { plexAdapterManifest } from '../packages/adapter-plex/src/index.js';

describe('Chrome extension manifest', () => {
  it('使用一致且有效的非零扩展版本', async () => {
    const [releaseVersion, rootPackage, extensionPackage, manifest] = await Promise.all(
      [
        '../VERSION',
        '../package.json',
        '../apps/chrome-extension/package.json',
        '../apps/chrome-extension/public/manifest.json',
      ].map(async (path) => readFile(new URL(path, import.meta.url), 'utf8')),
    );
    const versions = [
      releaseVersion.trim(),
      ...[rootPackage, extensionPackage, manifest].map(
        (content) => (JSON.parse(content) as { version: string }).version,
      ),
    ];
    const manifestVersion = (JSON.parse(manifest) as { version: string }).version;
    expect(new Set(versions)).toEqual(new Set([manifestVersion]));
    expect(releaseVersion.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const segments = manifestVersion.split('.');
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(
      segments.every((segment) => {
        if (!/^\d+$/.test(segment)) return false;
        const value = Number(segment);
        return value >= 0 && value <= 65_535 && String(value) === segment;
      }),
    ).toBe(true);
    expect(segments.some((segment) => Number(segment) > 0)).toBe(true);
  });

  it('只允许扩展内脚本，并为本地编解码 WASM 开启 MV3 能力', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../apps/chrome-extension/public/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as {
      content_security_policy?: { extension_pages?: string };
    };

    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    );
  });

  it('声明并随包分发完整的扩展图标规格', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../apps/chrome-extension/public/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as {
      icons?: Record<string, string>;
      action?: { default_icon?: Record<string, string> };
    };
    const icons = {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    };

    expect(manifest.icons).toEqual(icons);
    expect(manifest.action?.default_icon).toEqual({ '16': icons['16'], '32': icons['32'] });
    await Promise.all(
      Object.values(icons).map((path) =>
        access(new URL(`../apps/chrome-extension/public/${path}`, import.meta.url)),
      ),
    );
  });

  it('只在已激活 Plex 标签页对 DASH 建流请求声明 control-v1 能力', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../apps/chrome-extension/public/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as {
      permissions?: string[];
      declarative_net_request?: unknown;
    };
    const rule = plexControlSessionRule.create([17]);

    expect(manifest.permissions).toEqual([
      'declarativeNetRequestWithHostAccess',
      'storage',
      'webNavigation',
      'webRequest',
    ]);
    expect(manifest.declarative_net_request).toBeUndefined();
    expect(rule.action).toEqual({
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X-ShimWeave-Accept', operation: 'set', value: 'control-v1' }],
    });
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest', 'media', 'other']);
    expect(rule.condition.tabIds).toEqual([17]);
    const filter = new RegExp(rule.condition.regexFilter ?? 'never-match');
    expect(
      filter.test(
        'https://plex.example:20600/video/:/transcode/universal/start.mpd?path=%2Flibrary',
      ),
    ).toBe(true);
    expect(filter.test('https://plex.example/library/parts/1/file')).toBe(false);
  });

  it('以独立 MAIN Hook 复用 Plex 原生播放器且不公开旧 Player Frame', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../apps/chrome-extension/public/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as {
      content_scripts?: Array<{
        matches?: string[];
        js?: string[];
        run_at?: string;
        world?: string;
      }>;
      web_accessible_resources?: Array<{ resources?: string[] }>;
    };

    expect(manifest.content_scripts).toEqual([
      {
        matches: plexAdapterManifest.matchPatterns,
        js: ['plex-native-main.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: plexAdapterManifest.matchPatterns,
        js: ['plex-content.js'],
        run_at: 'document_start',
      },
    ]);
    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: [
          'worker-frame.html',
          'worker-frame.js',
          'media-worker.js',
          'range-coordinator.js',
          'chunks/*.js',
        ],
        matches: ['http://*/*', 'https://*/*'],
      },
    ]);
  });
});
