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
  }),
]);

await Promise.all([
  cp(resolve(applicationRoot, 'public'), outputRoot, { recursive: true }),
  cp(resolve(repositoryRoot, 'LICENSE'), resolve(outputRoot, 'LICENSE')),
]);
