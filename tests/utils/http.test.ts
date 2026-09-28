import { describe, expect, it, vi } from 'vitest';
import { httpGet, httpPost } from '@utils/http';

describe('http', () => {
  it('throws on network failure', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    try {
      await expect(httpGet('https://example.com')).rejects.toThrow(/fetch|network|retryable/i);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('parses JSON when Content-Type is JSON', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    try {
      const r = await httpGet<{ ok: number }>('https://example.com');
      expect(r.ok).toBe(1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('parses JSON even when Content-Type missing', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ a: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const r = await httpGet<{ a: number }>('https://example.com');
      expect(r.a).toBe(1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on non-json response', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    ) as unknown as typeof fetch;
    try {
      await expect(httpGet('https://example.com')).rejects.toThrow();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on 5xx', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('boom', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    try {
      await expect(httpGet('https://example.com', { retries: 0 })).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('aborts when AbortSignal aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}')) as unknown as typeof fetch;
    try {
      await expect(
        httpGet('https://example.com', { retries: 0, signal: ctrl.signal }),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('post sends json body and parses', async () => {
    const orig = globalThis.fetch;
    const mocked = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ echoed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = mocked as unknown as typeof fetch;
    try {
      const r = await httpPost<{ echoed: boolean }>('https://example.com', { x: 1 });
      expect(r.echoed).toBe(true);
      expect(mocked).toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });
});