import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = resolve(repositoryRoot, 'apps/chrome-extension');
const outputRoot = resolve(applicationRoot, 'dist');

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(applicationRoot, 'src/background.ts')],
    outfile: resolve(outputRoot, 'background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(applicationRoot, 'src/plex-content.ts')],
    outfile: resolve(outputRoot, 'plex-content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(applicationRoot, 'src/plex-native-main.ts')],
    outfile: resolve(outputRoot, 'plex-native-main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(applicationRoot, 'src/options.ts')],
    outfile: resolve(outputRoot, 'options.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(applicationRoot, 'src/worker-frame.ts')],
    outfile: resolve(outputRoot, 'worker-frame.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(applicationRoot, 'src/range-coordinator.ts')],
    outfile: resolve(applicationRoot, 'dist/range-coordinator.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
  }),
  build({
    entryPoints: { 'media-worker': resolve(applicationRoot, 'src/media-worker.ts') },
    outdir: outputRoot,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: true,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    // TrueHD 解码器把 WASM 内联成字符串，utf8 输出避免 esbuild 把控制字符转义成更长的形式。
    charset: 'utf8',
  }),
]);

await Promise.all([
  cp(resolve(applicationRoot, 'public'), outputRoot, { recursive: true }),
  cp(resolve(repositoryRoot, 'LICENSE'), resolve(outputRoot, 'LICENSE')),
  // TrueHD 解码使用 FFmpeg（LGPL-2.1+），随扩展附带其许可与来源说明。
  cp(
    resolve(repositoryRoot, 'packages/codec-truehd/wasm/NOTICE.FFmpeg.md'),
    resolve(outputRoot, 'licenses/FFmpeg.md'),
  ),
  cp(
    resolve(repositoryRoot, 'packages/codec-truehd/wasm/COPYING.LGPLv2.1'),
    resolve(outputRoot, 'licenses/COPYING.LGPLv2.1'),
  ),
]);
