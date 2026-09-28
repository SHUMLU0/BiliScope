/**
 * HTTP 客户端：超时、指数退避、限流、Malformed 错误统一包装。
 * 扩展环境里 fetch 必须 credentials: 'omit'（不读 Cookie）。
 */

import { logger } from './logger';

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  backoffBaseMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpError extends Error {
  status?: number;
  url?: string;
  retryable: boolean;
  body?: string;
}

export function makeHttpError(message: string, opts: Partial<HttpError> = {}): HttpError {
  const err = new Error(message) as HttpError;
  Object.assign(err, opts);
  err.retryable = opts.retryable ?? false;
  return err;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_BASE = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function httpGet<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  return httpJson<T>('GET', url, undefined, opts);
}

export async function httpPost<T = unknown>(
  url: string,
  body?: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  return httpJson<T>('POST', url, body, opts);
}

export async function httpJson<T = unknown>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffBase = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE;
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(opts.headers ?? {}),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let lastErr: HttpError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(t);
        throw makeHttpError('aborted', { url, retryable: false });
      }
      opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        credentials: 'omit',
        mode: 'cors',
        signal: ctrl.signal,
      });
      clearTimeout(t);

      if (res.status === 429) {
        const reset = Number(res.headers.get('X-RateLimit-Reset') ?? 0);
        const waitMs = reset > 0 ? Math.min(reset * 1000 - Date.now(), 30_000) : 5_000;
        logger.warn('rate-limited, waiting', waitMs, 'ms', url);
        lastErr = makeHttpError('rate-limited', { status: 429, url, retryable: true });
        if (attempt < retries) {
          await sleep(waitMs);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = res.status >= 500;
        throw makeHttpError(`HTTP ${res.status}`, {
          status: res.status,
          url,
          retryable,
          body: text.slice(0, 500),
        });
      }

      const ctype = res.headers.get('Content-Type') ?? '';
      if (!ctype.includes('json')) {
        const text = await res.text();
        try {
          return JSON.parse(text) as T;
        } catch {
          throw makeHttpError('non-json response', {
            status: res.status,
            url,
            retryable: false,
            body: text.slice(0, 500),
          });
        }
      }
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(t);
      const err: HttpError =
        e instanceof Error
          ? Object.assign(e as HttpError, {
              retryable: false,
              status: undefined,
              url,
              body: undefined,
            })
          : makeHttpError(String(e));
      const isAbort = err.name === 'AbortError';
      const isNet = err instanceof TypeError;
      const retryable = isAbort || isNet || (typeof err.status === 'number' && err.status >= 500);
      err.retryable = retryable;
      lastErr = err;

      if (attempt < retries && retryable) {
        const jitter = Math.random() * 200;
        const wait = backoffBase * 2 ** attempt + jitter;
        logger.debug('retry', attempt + 1, 'after', Math.round(wait), 'ms', url);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? makeHttpError('unknown failure', { url, retryable: false });
}