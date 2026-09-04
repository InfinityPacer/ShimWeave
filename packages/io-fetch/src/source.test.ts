import { describe, expect, it, vi } from 'vitest';
import {
  FetchRangeSource,
  FetchRangeSourceClosedError,
  FetchRangeTransportError,
  RangeProtocolError,
} from './source.js';

const response = (
  body: Uint8Array<ArrayBuffer>,
  options: { status?: number; contentRange?: string } = {},
): Response =>
  new Response(body, {
    status: options.status ?? 206,
    headers: options.contentRange ? { 'Content-Range': options.contentRange } : {},
  });

describe('FetchRangeSource', () => {
  it('发送单区间请求并返回经过 Content-Range 验证的字节', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response(Uint8Array.from([2, 3, 4]), { contentRange: 'bytes 2-4/10' }),
    );
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    await expect(source.read({ start: 2, end: 5 })).resolves.toEqual(Uint8Array.from([2, 3, 4]));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Range')).toBe('bytes=2-4');
  });

  it('先用票据换取临时 URL，再以无票据的新请求读取媒体 Range', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(input).startsWith('https://plex.example/')) {
        expect(headers.get('X-ShimWeave-Control-Token')).toBe('opaque-control-token');
        expect(headers.get('Range')).toBe('bytes=1-1');
        expect(init?.redirect).toBe('error');
        return new Response(null, {
          status: 204,
          headers: { 'X-ShimWeave-Media-Url': 'https://cdn.example/media?signature=private' },
        });
      }
      expect(String(input)).toBe('https://cdn.example/media?signature=private');
      expect(headers.get('X-ShimWeave-Control-Token')).toBeNull();
      expect(headers.get('Range')).toBe('bytes=1-1');
      expect(init?.redirect).toBe('follow');
      return response(Uint8Array.from([1]), { contentRange: 'bytes 1-1/10' });
    });
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://plex.example/_shimweave/control/v1/range',
      control: {
        requestHeaders: {
          'X-ShimWeave-Control-Token': 'opaque-control-token',
          Range: 'bytes=0-9',
        },
        responseUrlHeader: 'X-ShimWeave-Media-Url',
      },
      fetch,
    });

    await expect(source.read({ start: 1, end: 2 })).resolves.toEqual(Uint8Array.from([1]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('媒体 403 时重新执行一次控制交换并保持票据不进入 CDN', async () => {
    let controlCalls = 0;
    let mediaCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(input).startsWith('https://plex.example/')) {
        controlCalls += 1;
        expect(headers.get('X-ShimWeave-Control-Token')).toBe('opaque-control-token');
        return new Response(null, {
          status: 204,
          headers: {
            'X-ShimWeave-Media-Url': `https://cdn.example/media?generation=${controlCalls}`,
          },
        });
      }
      mediaCalls += 1;
      expect(headers.get('X-ShimWeave-Control-Token')).toBeNull();
      if (mediaCalls === 1) return response(new Uint8Array(), { status: 403 });
      return response(Uint8Array.from([7]), { contentRange: 'bytes 0-0/10' });
    });
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://plex.example/_shimweave/control/v1/range',
      control: {
        requestHeaders: { 'X-ShimWeave-Control-Token': 'opaque-control-token' },
        responseUrlHeader: 'X-ShimWeave-Media-Url',
      },
      fetch,
    });

    await expect(source.read({ start: 0, end: 1 })).resolves.toEqual(Uint8Array.from([7]));
    expect({ controlCalls, mediaCalls }).toEqual({ controlCalls: 2, mediaCalls: 2 });
  });

  it('control-v1 并发 403 只允许一个恢复 leader 先完成控制交换', async () => {
    const concurrency = 10;
    let controlCalls = 0;
    let mediaCalls = 0;
    let releaseFirstWave: () => void = () => undefined;
    let releaseLeader: () => void = () => undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const leader = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(input).startsWith('https://plex.example/')) {
        controlCalls += 1;
        return new Response(null, {
          status: 204,
          headers: {
            'X-ShimWeave-Media-Url': `https://cdn.example/media?generation=${controlCalls}`,
          },
        });
      }

      mediaCalls += 1;
      const call = mediaCalls;
      if (call <= concurrency) {
        if (call === concurrency) releaseFirstWave();
        await firstWave;
        return response(new Uint8Array(), { status: 403 });
      }
      if (call === concurrency + 1) await leader;
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range') ?? '');
      const offset = Number(match?.[1]);
      return response(Uint8Array.from([offset]), {
        contentRange: `bytes ${offset}-${offset}/100`,
      });
    });
    const source = new FetchRangeSource({
      sourceId: 'stable-source',
      url: 'https://plex.example/_shimweave/control/v1/range',
      control: {
        requestHeaders: { 'X-ShimWeave-Control-Token': 'opaque-control-token' },
        responseUrlHeader: 'X-ShimWeave-Media-Url',
      },
      fetch,
    });

    const reads = Promise.all(
      Array.from({ length: concurrency }, (_, offset) =>
        source.read({ start: offset, end: offset + 1 }),
      ),
    );
    await vi.waitFor(() => expect(mediaCalls).toBe(concurrency + 1));
    expect(controlCalls).toBe(concurrency + 1);
    releaseLeader();

    await expect(reads).resolves.toEqual(
      Array.from({ length: concurrency }, (_, offset) => Uint8Array.from([offset])),
    );
    expect({ controlCalls, mediaCalls }).toEqual({
      controlCalls: concurrency * 2,
      mediaCalls: concurrency * 2,
    });
  });

  it('调用注入的 Fetch 时不绑定到 Source 实例', async () => {
    let receiver: unknown = 'not-called';
    const fetch = async function (this: unknown): Promise<Response> {
      receiver = this;
      return response(Uint8Array.from([0]), { contentRange: 'bytes 0-0/10' });
    };
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    await source.read({ start: 0, end: 1 });
    expect(receiver).toBeUndefined();
  });

  it('拒绝把完整文件 200 响应当作 Range 数据', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch: async () => new Response(body, { status: 200 }),
    });

    await expect(source.read({ start: 0, end: 3 })).rejects.toMatchObject({
      code: 'unexpected_status',
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined, 'missing_content_range'],
    ['wrong range', 'bytes 1-3/10', 'mismatched_content_range'],
    ['unknown size', 'bytes 0-2/*', 'missing_content_range'],
    ['end beyond size', 'bytes 0-2/2', 'missing_content_range'],
  ])('拒绝 %s Content-Range', async (_name, contentRange, code) => {
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch: async () =>
        response(Uint8Array.from([0, 1, 2]), {
          ...(contentRange ? { contentRange } : {}),
        }),
    });

    await expect(source.read({ start: 0, end: 3 })).rejects.toMatchObject({ code });
  });

  it('拒绝响应体长度不匹配并保留结构化错误字段', async () => {
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch: async () => response(Uint8Array.from([0, 1]), { contentRange: 'bytes 0-2/10' }),
    });

    await expect(source.read({ start: 0, end: 3 })).rejects.toMatchObject({
      code: 'body_length_mismatch',
      expected: 3,
      actual: 2,
    });
  });

  it('尺寸探测复用首个媒体块，避免紧邻的重叠 Range 请求', async () => {
    const head = new Uint8Array(512 * 1024);
    head.set([1, 2, 3], 0);
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response(head, { contentRange: `bytes 0-${head.byteLength - 1}/1048576` }),
    );
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    await expect(
      Promise.all([source.getSize(), source.read({ start: 0, end: 3 })]),
    ).resolves.toEqual([1048576, Uint8Array.from([1, 2, 3])]);
    await expect(source.getSize()).resolves.toBe(1048576);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Range')).toBe('bytes=0-524287');
  });

  it('尺寸探测接受在文件尾缩短的合法 Range', async () => {
    const body = Uint8Array.from([0, 1, 2]);
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch: async () => response(body, { contentRange: 'bytes 0-2/3' }),
    });

    await expect(source.getSize()).resolves.toBe(3);
    await expect(source.read({ start: 1, end: 3 })).resolves.toEqual(Uint8Array.from([1, 2]));
  });

  it('并发首读会原子锁定文件尺寸并拒绝另一份内容', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(Uint8Array.from([0]), { contentRange: 'bytes 0-0/10' }))
      .mockResolvedValueOnce(response(Uint8Array.from([1]), { contentRange: 'bytes 1-1/11' }));
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    const results = await Promise.allSettled([
      source.read({ start: 0, end: 1 }),
      source.read({ start: 1, end: 2 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'source_size_changed',
    });
  });

  it('取消尺寸查询会中止对应的头部 Range 请求', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      },
    );
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });
    const controller = new AbortController();

    const size = source.getSize(controller.signal);
    controller.abort(new Error('session left'));

    await expect(size).rejects.toThrow('session left');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('发现同一会话的源尺寸变化时拒绝混用数据', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(Uint8Array.from([0]), { contentRange: 'bytes 0-0/10' }))
      .mockResolvedValueOnce(response(Uint8Array.from([1]), { contentRange: 'bytes 1-1/11' }));
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    await source.read({ start: 0, end: 1 });
    await expect(source.read({ start: 1, end: 2 })).rejects.toMatchObject({
      code: 'source_size_changed',
    });
  });

  it('关闭时中止活动请求且后续读取明确失败', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      },
    );
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media',
      fetch,
    });

    const reading = source.read({ start: 0, end: 1 });
    source.close();

    await expect(reading).rejects.toBeInstanceOf(FetchRangeSourceClosedError);
    expect(requestSignal?.aborted).toBe(true);
    await expect(source.read({ start: 0, end: 1 })).rejects.toBeInstanceOf(
      FetchRangeSourceClosedError,
    );
  });

  it('将未形成 HTTP 响应的读取失败归类为传输错误', async () => {
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media?secret=signed-value',
      fetch: async () => Promise.reject(new TypeError('network request failed')),
    });

    const error = await source.read({ start: 0, end: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchRangeTransportError);
    expect(error).toMatchObject({ cause: expect.any(TypeError) });
    expect(String(error)).not.toContain('signed-value');
  });

  it('十个并发 403 只由一个 leader 重试，恢复后其余 Range 各重试一次', async () => {
    const concurrency = 10;
    let calls = 0;
    let releaseFirstWave: () => void = () => undefined;
    let releaseLeader: () => void = () => undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const leader = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const call = calls;
      const range = new Headers(init?.headers).get('Range');
      if (call <= concurrency) {
        if (call === concurrency) releaseFirstWave();
        await firstWave;
        return response(new Uint8Array(), { status: 403 });
      }
      if (call === concurrency + 1) await leader;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      const offset = Number(match?.[1]);
      return response(Uint8Array.from([offset]), {
        contentRange: `bytes ${offset}-${offset}/100`,
      });
    });
    const source = new FetchRangeSource({
      sourceId: 'stable-source',
      url: 'https://plex.example/_shimweave/control/v1/range',
      fetch,
    });

    const reads = Promise.all(
      Array.from({ length: concurrency }, (_, offset) =>
        source.read({ start: offset, end: offset + 1 }),
      ),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(concurrency + 1));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(concurrency + 1);
    releaseLeader();

    await expect(reads).resolves.toEqual(
      Array.from({ length: concurrency }, (_, offset) => Uint8Array.from([offset])),
    );
    expect(fetch).toHaveBeenCalledTimes(concurrency * 2);
  });

  it('403 恢复失败时并发等待者共享失败且不继续放大重试', async () => {
    let calls = 0;
    let releaseFirstWave: () => void = () => undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const source = new FetchRangeSource({
      sourceId: 'stable-source',
      url: 'https://plex.example/_shimweave/control/v1/range',
      fetch: async () => {
        calls += 1;
        if (calls === 2) releaseFirstWave();
        if (calls <= 2) await firstWave;
        return response(new Uint8Array(), { status: 403 });
      },
    });

    const results = await Promise.allSettled([
      source.read({ start: 0, end: 1 }),
      source.read({ start: 1, end: 2 }),
    ]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(3);
  });

  it('错误对象不会包含签名 URL', async () => {
    const source = new FetchRangeSource({
      sourceId: 'media-1',
      url: 'https://cdn.example/media?secret=signed-value',
      fetch: async () => response(new Uint8Array(), { status: 403 }),
    });

    const error = await source.read({ start: 0, end: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RangeProtocolError);
    expect(String(error)).not.toContain('signed-value');
    expect(JSON.stringify(source)).not.toContain('signed-value');
  });
});
