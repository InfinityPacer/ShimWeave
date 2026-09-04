import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(repositoryRoot, 'apps/chrome-extension/dist');
const artifactRoot = resolve(repositoryRoot, 'artifacts');
const fixedTimestamp = new Date('2000-01-01T00:00:00.000Z');
const packageFiles = new Set([
  'background.js',
  'LICENSE',
  'manifest.json',
  'media-worker.js',
  'plex-content.js',
  'plex-native-main.js',
  'range-coordinator.js',
  'worker-frame.html',
  'worker-frame.js',
]);

const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
  throw new TypeError('Extension manifest has no valid package version');
}

const artifactName = `shimweave-${manifest.version}.zip`;
const artifactPath = resolve(artifactRoot, artifactName);
const checksumPath = `${artifactPath}.sha256`;
const stagingRoot = await mkdtemp(join(tmpdir(), 'shimweave-package-'));

try {
  const files = await collectPackageFiles(extensionRoot);
  for (const sourcePath of files) {
    const relativePath = relative(extensionRoot, sourcePath);
    const targetPath = resolve(stagingRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o644);
    await utimes(targetPath, fixedTimestamp, fixedTimestamp);
  }

  await mkdir(artifactRoot, { recursive: true });
  await rm(artifactPath, { force: true });
  await rm(checksumPath, { force: true });
  await runZip(
    stagingRoot,
    artifactPath,
    files.map((path) => relative(extensionRoot, path)),
  );

  const archive = await readFile(artifactPath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(checksumPath, `${checksum}  ${basename(artifactPath)}\n`, 'utf8');

  process.stdout.write(`${relative(repositoryRoot, artifactPath)}\n`);
  process.stdout.write(`${checksum}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

async function collectPackageFiles(root) {
  const result = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name.endsWith('.map')) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, path);
      if (!isPackageFile(relativePath)) {
        throw new Error(`Unexpected file in extension package: ${relativePath}`);
      }
      const metadata = await stat(path);
      if (metadata.size < 0) throw new Error(`Invalid package file: ${path}`);
      result.push(path);
    }
  };
  await visit(root);
  return result;
}

function isPackageFile(path) {
  if (packageFiles.has(path)) return true;
  if (/^chunks\/[^/]+\.js$/.test(path)) return true;
  return /^icons\/[^/]+\.png$/.test(path);
}

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function runZip(cwd, outputPath, files) {
  if (files.length === 0) throw new Error('Extension build contains no package files');
  return new Promise((resolvePromise, reject) => {
    const child = spawn('zip', ['-9', '-X', '-q', outputPath, ...files], {
      cwd,
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`zip failed with ${signal ?? `exit code ${code ?? 'unknown'}`}`));
    });
  });
}
