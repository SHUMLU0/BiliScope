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

  // V0.1.3（P1-HTTP retry）：
  // 旧实现在 catch 里无条件 `status: undefined`，把 5xx 的 status 抹掉，
  // 导致 retryable 恒为 false —— 5xx 一次都不会重试。下面两条是回归测试。
  it('5xx 触发重试并最终成功（503 → 503 → 200）', async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) return new Response('busy', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const r = await httpGet<{ ok: number }>('https://example.com', { backoffBaseMs: 1 });
      expect(r.ok).toBe(1);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('连续 5xx 达到重试上限后失败（503 × 4）', async () => {
    const orig = globalThis.fetch;
    const mocked = vi.fn().mockResolvedValue(
      new Response('busy', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
    );
    globalThis.fetch = mocked as unknown as typeof fetch;
    try {
      await expect(httpGet('https://example.com', { backoffBaseMs: 1 })).rejects.toThrow(/503/);
      // 默认 retries=3 → 共 4 次请求
      expect(mocked).toHaveBeenCalledTimes(4);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('5xx 错误保留 status 字段（retryable 的依据）', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('busy', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    try {
      await expect(httpGet('https://example.com', { retries: 0, backoffBaseMs: 1 })).rejects.toMatchObject({
        status: 500,
        retryable: true,
      });
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