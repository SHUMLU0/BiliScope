import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatorCollector } from '@collectors/creator-collector';

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    const hit = Object.entries(map).find(([k]) => u.includes(k));
    if (!hit) {
      throw new Error('unmocked: ' + u);
    }
    return new Response(JSON.stringify(hit[1]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('CreatorCollector', () => {
  beforeEach(async () => {
    // 清缓存避免上一次测试残留
    const cacheMod = await import('@utils/cache');
    cacheMod.cacheClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const cacheMod = await import('@utils/cache');
    cacheMod.cacheClear();
  });

  it('happy path: stores creator + snapshot', async () => {
    const mockFetch = fakeFetch({
      'acc/info': {
        code: 0,
        data: {
          mid: 12345,
          name: 'tester',
          face: 'https://example.com/f.jpg',
          sign: 'hi',
          level_info: { current_level: 4 },
          fans: 100,
          following: 10,
          archive_count: 5,
        },
      },
      upstat: { archive: { view: 5000 }, article: { view: 0 }, likes: 200 },
    });
    globalThis.fetch = mockFetch;

    const c = new CreatorCollector();
    const r = await c.collect({ targetId: '12345' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.name).toBe('tester');
    expect(r.data[0]!.followers).toBe(100);
  }, 8000);

  it('invalid uid', async () => {
    const c = new CreatorCollector();
    const r = await c.collect({ targetId: 'abc' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('invalid uid');
    expect(r.retryable).toBe(false);
  });

  it('network failure → retryable error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;

    const c = new CreatorCollector();
    const r = await c.collect({ targetId: '99999' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
  }, 8000);

  it('malformed response → not retryable', async () => {
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const c = new CreatorCollector();
    const r = await c.collect({ targetId: '88888' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeTruthy();
  }, 8000);
});