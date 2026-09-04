import type { ByteRange, ByteSource } from '@shimweave/contracts';

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchRangeSourceOptions {
  /** 稳定的不透明内容身份，不得使用会过期的签名 URL。 */
  sourceId: string;
  /** 只保存在 ECMAScript 私有字段中的临时远程地址。 */
  url: string;
  /** 测试或扩展执行上下文提供的 Fetch 实现。 */
  fetch?: FetchFunction;
  /** 可选控制交换；控制凭据永远不会进入随后发往媒体源的请求。 */
  control?: {
    requestHeaders: Readonly<Record<string, string>>;
    responseUrlHeader: string;
    expectedStatus?: number;
  };
}

export type RangeProtocolErrorCode =
  | 'unexpected_control_status'
  | 'missing_control_url'
  | 'invalid_control_url'
  | 'unexpected_status'
  | 'missing_content_range'
  | 'mismatched_content_range'
  | 'invalid_source_size'
  | 'source_size_changed'
  | 'body_length_mismatch';

/** FetchRangeSource 只接受可验证的 HTTP 206，避免把整片 200 响应送入浏览器内存。 */
export class FetchRangeSource implements ByteSource {
  readonly sourceId: string;

  readonly #url: string;
  readonly #control:
    | { requestHeaders: Headers; responseUrlHeader: string; expectedStatus: number }
    | undefined;
  private readonly fetch: FetchFunction;
  private readonly active = new Set<AbortController>();
  private bootstrap: { range: ByteRange; bytes: Uint8Array } | undefined;
  private knownSize: number | undefined;
  private sizePromise: Promise<number> | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: FetchRangeSourceOptions) {
    if (options.sourceId.trim() === '') throw new TypeError('sourceId must not be empty');
    const url = new URL(options.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('Range source URL must use HTTP or HTTPS');
    }
    const fetchFunction = options.fetch ?? globalThis.fetch;
    if (typeof fetchFunction !== 'function') throw new TypeError('Fetch API is not available');

    this.sourceId = options.sourceId;
    this.#url = url.href;
    if (options.control) {
      const responseUrlHeader = options.control.responseUrlHeader.trim();
      if (responseUrlHeader === '') throw new TypeError('Control URL header must not be empty');
      const requestHeaders = new Headers(options.control.requestHeaders);
      requestHeaders.delete('Range');
      this.#control = {
        requestHeaders,
        responseUrlHeader,
        expectedStatus: options.control.expectedStatus ?? 204,
      };
    }
    this.fetch = options.fetch ? fetchFunction : fetchFunction.bind(globalThis);
  }

  getSize(signal?: AbortSignal): Promise<number> {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.knownSize !== undefined) return withAbort(Promise.resolve(this.knownSize), signal);
    if (!this.sizePromise) {
      const pending = this.fetchRange(
        { start: 0, end: DEFAULT_SIZE_PROBE_BYTES },
        signal,
        true,
      ).then(({ range, bytes, size }) => {
        this.bootstrap = { range, bytes };
        return size;
      });
      const tracked = pending.catch((error: unknown) => {
        if (this.sizePromise === tracked) this.sizePromise = undefined;
        throw error;
      });
      this.sizePromise = tracked;
    }
    return withAbort(this.sizePromise, signal);
  }

  async read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    validateRange(range);
    if (this.sizePromise && this.knownSize === undefined) await withAbort(this.sizePromise, signal);
    if (this.knownSize !== undefined && range.end > this.knownSize) {
      throw new RangeError('Byte range exceeds the known source size');
    }
    if (signal?.aborted) throw abortReason(signal);

    const bootstrap = this.bootstrap;
    if (bootstrap && covers(bootstrap.range, range)) {
      return sliceRange(bootstrap.range, bootstrap.bytes, range);
    }

    return (await this.fetchRange(range, signal, false)).bytes;
  }

  private async fetchRange(
    range: ByteRange,
    signal: AbortSignal | undefined,
    allowEofClamp: boolean,
  ): Promise<{ range: ByteRange; bytes: Uint8Array; size: number }> {
    if (signal?.aborted) throw abortReason(signal);

    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    signal?.addEventListener('abort', relayAbort, { once: true });
    this.active.add(controller);

    try {
      try {
        return await this.requestRange(range, controller.signal, allowEofClamp);
      } catch (error) {
        if (!(error instanceof RangeProtocolError) || error.status !== 403) throw error;
        return await this.retryAfterForbidden(range, controller.signal, allowEofClamp);
      }
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      this.active.delete(controller);
    }
  }

  /**
   * 同一媒体出现并发 403 时只有首个请求执行恢复重试；其余请求等待该结果，
   * 恢复成功后各自再尝试一次，避免过期直链触发并发重试风暴。
   */
  private async retryAfterForbidden(
    range: ByteRange,
    signal: AbortSignal,
    allowEofClamp: boolean,
  ): Promise<{ range: ByteRange; bytes: Uint8Array; size: number }> {
    const activeRecovery = this.recoveryPromise;
    if (activeRecovery) {
      await withAbort(activeRecovery, signal);
      return this.requestRange(range, signal, allowEofClamp);
    }

    const retry = this.requestRange(range, signal, allowEofClamp);
    const barrier = retry.then(() => undefined);
    void barrier.catch(() => undefined);
    this.recoveryPromise = barrier;
    try {
      return await retry;
    } finally {
      if (this.recoveryPromise === barrier) this.recoveryPromise = undefined;
    }
  }

  private async requestRange(
    range: ByteRange,
    signal: AbortSignal,
    allowEofClamp: boolean,
  ): Promise<{ range: ByteRange; bytes: Uint8Array; size: number }> {
    const rangeHeader = `bytes=${range.start}-${range.end - 1}`;
    let mediaURL = this.#url;
    if (this.#control) mediaURL = await this.resolveControlledMediaURL(rangeHeader, signal);
    if (signal.aborted) throw abortReason(signal);
    const response = await this.fetchResponse(
      mediaURL,
      {
        method: 'GET',
        headers: { Accept: '*/*', Range: rangeHeader },
        // CDN 响应不得进入浏览器 HTTP 缓存；RangeBroker 管理媒体块复用。
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal,
      },
      signal,
    );
    if (response.status !== 206) {
      await cancelBody(response);
      throw new RangeProtocolError('unexpected_status', { status: response.status });
    }

    const parsed = parseContentRange(response.headers.get('Content-Range'));
    if (!parsed) {
      await cancelBody(response);
      throw new RangeProtocolError('missing_content_range');
    }
    const exactRange = parsed.start === range.start && parsed.endExclusive === range.end;
    const clampedAtEof =
      allowEofClamp &&
      parsed.start === range.start &&
      parsed.endExclusive === parsed.size &&
      parsed.endExclusive < range.end;
    if (!exactRange && !clampedAtEof) {
      await cancelBody(response);
      throw new RangeProtocolError('mismatched_content_range');
    }
    if (!Number.isSafeInteger(parsed.size) || parsed.size <= 0) {
      await cancelBody(response);
      throw new RangeProtocolError('invalid_source_size');
    }
    if (this.knownSize !== undefined && this.knownSize !== parsed.size) {
      await cancelBody(response);
      throw new RangeProtocolError('source_size_changed');
    }
    // 比较与锁定之间不让出执行权，避免并发首读混入另一份内容。
    this.knownSize = parsed.size;

    const bytes = new Uint8Array(await response.arrayBuffer());
    const expected = parsed.endExclusive - parsed.start;
    if (bytes.byteLength !== expected) {
      throw new RangeProtocolError('body_length_mismatch', {
        expected,
        actual: bytes.byteLength,
      });
    }
    return {
      range: { start: parsed.start, end: parsed.endExclusive },
      bytes,
      size: parsed.size,
    };
  }

  private async resolveControlledMediaURL(
    rangeHeader: string,
    signal: AbortSignal,
  ): Promise<string> {
    const control = this.#control;
    if (!control) throw new RangeProtocolError('missing_control_url');
    const headers = new Headers(control.requestHeaders);
    headers.set('Accept', '*/*');
    headers.set('Range', rangeHeader);
    const response = await this.fetchResponse(
      this.#url,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      },
      signal,
    );
    if (response.status !== control.expectedStatus) {
      await cancelBody(response);
      throw new RangeProtocolError('unexpected_control_status', { status: response.status });
    }
    const rawURL = response.headers.get(control.responseUrlHeader)?.trim();
    await cancelBody(response);
    if (!rawURL) throw new RangeProtocolError('missing_control_url');
    let mediaURL: URL;
    try {
      mediaURL = new URL(rawURL);
    } catch {
      throw new RangeProtocolError('invalid_control_url');
    }
    if (
      (mediaURL.protocol !== 'http:' && mediaURL.protocol !== 'https:') ||
      mediaURL.username !== '' ||
      mediaURL.password !== ''
    ) {
      throw new RangeProtocolError('invalid_control_url');
    }
    return mediaURL.href;
  }

  private async fetchResponse(
    input: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      const fetchRange = this.fetch;
      return await fetchRange(input, init);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new FetchRangeTransportError({ cause: error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new FetchRangeSourceClosedError();
    for (const controller of this.active) controller.abort(error);
    this.active.clear();
    this.bootstrap = undefined;
    this.sizePromise = undefined;
    this.recoveryPromise = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new FetchRangeSourceClosedError();
  }
}

const DEFAULT_SIZE_PROBE_BYTES = 512 * 1024;

/** RangeProtocolError 描述不可信远程响应违反的 Range 协议约束。 */
export class RangeProtocolError extends Error {
  readonly status?: number;
  readonly expected?: number;
  readonly actual?: number;

  constructor(
    readonly code: RangeProtocolErrorCode,
    details: { status?: number; expected?: number; actual?: number } = {},
  ) {
    super(`Range response failed protocol validation: ${code}`);
    this.name = 'RangeProtocolError';
    if (details.status !== undefined) this.status = details.status;
    if (details.expected !== undefined) this.expected = details.expected;
    if (details.actual !== undefined) this.actual = details.actual;
  }
}

/** FetchRangeSourceClosedError 表示读取所属媒体会话已经释放。 */
export class FetchRangeSourceClosedError extends Error {
  constructor() {
    super('Fetch range source is closed');
    this.name = 'FetchRangeSourceClosedError';
  }
}

/** FetchRangeTransportError 表示请求未形成可验证的 HTTP 响应，调用方可与状态码错误分开处理。 */
export class FetchRangeTransportError extends Error {
  constructor(options: ErrorOptions = {}) {
    super('Range request failed before receiving an HTTP response', options);
    this.name = 'FetchRangeTransportError';
  }
}

const validateRange = (range: ByteRange): void => {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  ) {
    throw new RangeError('Byte range must be a non-empty safe integer interval');
  }
};

const parseContentRange = (
  value: string | null,
): { start: number; endExclusive: number; size: number } | undefined => {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const size = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    endInclusive < start ||
    size <= endInclusive
  ) {
    return undefined;
  }
  return { start, endExclusive: endInclusive + 1, size };
};

const covers = (outer: ByteRange, inner: ByteRange): boolean =>
  outer.start <= inner.start && outer.end >= inner.end;

const sliceRange = (outer: ByteRange, bytes: Uint8Array, inner: ByteRange): Uint8Array =>
  bytes.subarray(inner.start - outer.start, inner.end - outer.start);

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // 协议错误优先返回给调用方，传输层取消失败不覆盖根因。
  }
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const withAbort = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};
