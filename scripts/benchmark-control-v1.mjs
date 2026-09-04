import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { FetchRangeSource } from '../packages/io-fetch/dist/index.js';

const sourceSize = 16 * 1024 * 1024;
const rangeSize = 64 * 1024;
const mediaBody = Buffer.alloc(rangeSize, 0x5a);
let origin = '';
let controlCalls = 0;
let mediaCalls = 0;
let failNextMedia = 0;

const server = createServer((request, response) => {
  if (request.url === '/control') {
    controlCalls += 1;
    response.writeHead(204, {
      'Cache-Control': 'no-store',
      'X-ShimWeave-Media-Url': `${origin}/media`,
    });
    response.end();
    return;
  }

  if (request.url !== '/media') {
    response.writeHead(404).end();
    return;
  }

  mediaCalls += 1;
  if (failNextMedia > 0) {
    failNextMedia -= 1;
    response.writeHead(403).end();
    return;
  }

  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (!match) {
    response.writeHead(416).end();
    return;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const length = end - start + 1;
  response.writeHead(206, {
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Content-Range': `bytes ${start}-${end}/${sourceSize}`,
  });
  response.end(mediaBody.subarray(0, length));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
origin = `http://127.0.0.1:${address.port}`;

const direct = new FetchRangeSource({ sourceId: 'direct', url: `${origin}/media` });
const controlled = new FetchRangeSource({
  sourceId: 'controlled',
  url: `${origin}/control`,
  control: {
    requestHeaders: { 'X-ShimWeave-Control-Token': 'benchmark-token' },
    responseUrlHeader: 'X-ShimWeave-Media-Url',
  },
});

const rangeAt = (index) => {
  const start = (index % (sourceSize / rangeSize)) * rangeSize;
  return { start, end: start + rangeSize };
};
const summarize = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)];
  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    meanMs: samples.reduce((total, value) => total + value, 0) / samples.length,
  };
};
const sequential = async (source, iterations, offset) => {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await source.read(rangeAt(index + offset));
    samples.push(performance.now() - started);
  }
  return summarize(samples);
};
const concurrent = async (source, batches, width, offset) => {
  const samples = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const started = performance.now();
    await Promise.all(
      Array.from({ length: width }, (_, index) =>
        source.read(rangeAt(offset + batch * width + index)),
      ),
    );
    samples.push(performance.now() - started);
  }
  return summarize(samples);
};
const resetCounts = () => {
  controlCalls = 0;
  mediaCalls = 0;
};

try {
  await sequential(direct, 40, 0);
  await sequential(controlled, 40, 40);
  resetCounts();

  const directSequential = await sequential(direct, 300, 80);
  const directCounts = { controlCalls, mediaCalls };
  resetCounts();

  const controlledSequential = await sequential(controlled, 300, 380);
  const controlledCounts = { controlCalls, mediaCalls };
  resetCounts();

  const controlledConcurrent6 = await concurrent(controlled, 80, 6, 680);
  const concurrentCounts = { controlCalls, mediaCalls };
  resetCounts();

  failNextMedia = 6;
  const recoveryStarted = performance.now();
  await Promise.all(
    Array.from({ length: 6 }, (_, index) => controlled.read(rangeAt(1200 + index))),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        environment: { node: process.version, rangeBytes: rangeSize },
        directSequential: { ...directSequential, ...directCounts },
        controlledSequential: { ...controlledSequential, ...controlledCounts },
        controlledConcurrent6: { ...controlledConcurrent6, ...concurrentCounts },
        concurrent403Recovery: {
          elapsedMs: performance.now() - recoveryStarted,
          controlCalls,
          mediaCalls,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  direct.close();
  controlled.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
