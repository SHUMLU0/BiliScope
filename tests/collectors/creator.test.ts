import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatorCollector } from '@collectors/creator-collector';

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    // 优先最长前缀匹配，避免短 key 抢匹配
    const hit = Object.entries(map)
      .sort(([a], [b]) => b.length - a.length)
      .find(([k]) => u.includes(k));
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
    // 清 WBI 缓存，确保每次都重新拉 nav
    const wbiMod = await import('@utils/wbi');
    wbiMod.loadCachedMixinKey(); // 仅触发 module load
    wbiMod.__resetWbiForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const cacheMod = await import('@utils/cache');
    cacheMod.cacheClear();
    const wbiMod = await import('@utils/wbi');
    wbiMod.__resetWbiForTest();
  });

  it('happy path: stores creator + snapshot (uses new wbi/acc/info endpoint)', async () => {
    const mockFetch = fakeFetch({
      // WBI 刷新：nav 必须返回 img_url + sub_url，否则 buildWbiAccInfoUrl 会抛错
      'x/web-interface/nav': {
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7e7176dae0f5e2fc4b5ed1b7e08a8f87.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/5e1b9e9c2c2f8b0f0f4b0b5e1b7e08a8f.png',
          },
        },
      },
      'wbi/acc/info': {
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
      // V0.1.1：upstat URL 必须含 ?mid=
      upstat: { archive: { view: 5000 }, article: { view: 0 }, likes: 200 },
    });
    globalThis.fetch = mockFetch;

    const c = new CreatorCollector();
    const r = await c.collect({ targetId: '12345' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.name).toBe('tester');
    expect(r.data[0]!.followers).toBe(100);
    // 验证 wbi/acc/info 被调用（而不是旧 acc/info）
    const calledUrls = (mockFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(calledUrls.some((u) => u.includes('wbi/acc/info'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('upstat?mid=12345'))).toBe(true);
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

  it('upstat 失败 → creator 仍能采集成功（V0.1.1 非致命降级）', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('x/web-interface/nav')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/7e7176dae0f5e2fc4b5ed1b7e08a8f87.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/5e1b9e9c2c2f8b0f0f4b0b5e1b7e08a8f.png',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('wbi/acc/info')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              mid: 11111,
              name: 'upstat-fail',
              face: '',
              sign: '',
              level_info: { current_level: 1 },
              fans: 1,
              following: 0,
              archive_count: 0,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('upstat')) {
        throw new TypeError('upstat blocked');
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    const c = new CreatorCollector();
    const r = await c.collect({ targetId: '11111' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.name).toBe('upstat-fail');
    // totals 全 0
    const sn = await (await import('@repositories/index')).creatorSnapshotRepo.listByCreator(
      r.data[0]!.id,
    );
    expect(sn.length).toBe(1);
    expect(sn[0]!.totalViews).toBe(0);
    expect(sn[0]!.totalLikes).toBe(0);
  }, 8000);

  it('返回的 Creator.id 与 DB 中持久化 id 一致（V0.1.1 temp ID 修复）', async () => {
    const mockFetch = fakeFetch({
      'x/web-interface/nav': {
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/aaa.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/bbb.png',
          },
        },
      },
      'wbi/acc/info': {
        code: 0,
        data: {
          mid: 22222,
          name: 'persist-id-test',
          face: '',
          sign: '',
          level_info: { current_level: 0 },
          fans: 0,
          following: 0,
          archive_count: 0,
        },
      },
      upstat: { archive: { view: 0 }, article: { view: 0 }, likes: 0 },
    });
    globalThis.fetch = mockFetch;

    const c = new CreatorCollector();
    const r1 = await c.collect({ targetId: '22222' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const id1 = r1.data[0]!.id;

    // 第二次采集同一 uid，id 必须不变
    const r2 = await c.collect({ targetId: '22222' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data[0]!.id).toBe(id1);

    // 验证 snapshot 能用这个 id 查到
    const { creatorSnapshotRepo } = await import('@repositories/index');
    const snaps = await creatorSnapshotRepo.listByCreator(id1);
    expect(snaps.length).toBeGreaterThanOrEqual(2);
  }, 8000);
});