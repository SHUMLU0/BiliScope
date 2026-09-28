import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoCollector } from '@collectors/video-collector';
import { db } from '@db/database';
import { creatorSchema } from '@models/creator';
import { nowIso } from '@utils/time';

describe('VideoCollector', () => {
  beforeEach(async () => {
    // 清缓存避免上一次测试残留
    const cacheMod = await import('@utils/cache');
    cacheMod.cacheClear();
    const wbiMod = await import('@utils/wbi');
    wbiMod.__resetWbiForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const cacheMod = await import('@utils/cache');
    cacheMod.cacheClear();
    const wbiMod = await import('@utils/wbi');
    wbiMod.__resetWbiForTest();
  });

  // V0.1.1 修复：必须先用 refreshWbi() 拉 nav，再用 signWbi() 签 URL
  it('happy path: wbi/arc/search URL contains wts + w_rid (V0.1.1 WBI 接入)', async () => {
    await db.creators.add(
      creatorSchema.parse({
        id: 'cr_seed',
        uid: 7777777,
        name: 'seed',
        avatar: undefined,
        sign: '',
        level: 0,
        followers: 0,
        following: 0,
        videoCount: 0,
        spaceUrl: 'https://space.bilibili.com/7777777/',
        lastCollectedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'manual',
      }),
    );

    const calls_log: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls_log.push(u);
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
      if (u.includes('wbi/arc/search')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              list: {
                vlist: [
                  {
                    bvid: 'BV1xxxxxxxxx',
                    aid: 100,
                    title: 'video-1',
                    desc: 'd',
                    pic: 'https://example.com/c.jpg',
                    pubdate: 1700000000,
                    duration: 200,
                    tname: '知识',
                    tag: 'a,b',
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('x/web-interface/view')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              bvid: 'BV1xxxxxxxxx',
              aid: 100,
              view: 1000,
              like: 10,
              coin: 1,
              favorite: 2,
              share: 0,
              reply: 1,
              danmaku: 5,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    const c = new VideoCollector();
    const r = await c.collect({ targetId: '7777777' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);

    const wbiCall = calls_log.find((u) => u.includes('wbi/arc/search'));
    expect(wbiCall).toBeTruthy();
    // V0.1.1：必须包含 wts 与 w_rid
    expect(wbiCall!).toMatch(/[?&]wts=\d+/);
    expect(wbiCall!).toMatch(/[?&]w_rid=[a-f0-9]+/);
    // nav 必须先被调用（refreshWbi）
    expect(calls_log.some((u) => u.includes('x/web-interface/nav'))).toBe(true);
  }, 15000);

  it('invalid uid', async () => {
    const c = new VideoCollector();
    const r = await c.collect({ targetId: 'abc' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('invalid uid');
  });

  it('creator not found', async () => {
    const c = new VideoCollector();
    const r = await c.collect({ targetId: '8888888' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/creator not found/);
  });

  it('WBI 签名失败时降级到 legacy arc/search', async () => {
    await db.creators.add(
      creatorSchema.parse({
        id: 'cr_seed2',
        uid: 6666666,
        name: 'seed2',
        avatar: undefined,
        sign: '',
        level: 0,
        followers: 0,
        following: 0,
        videoCount: 0,
        spaceUrl: 'https://space.bilibili.com/6666666/',
        lastCollectedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'manual',
      }),
    );

    const calls_log: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls_log.push(u);
      // nav 失败 → WBI 不可用 → 应降级
      if (u.includes('x/web-interface/nav')) {
        return new Response('error', { status: 500 });
      }
      if (u.includes('wbi/arc/search')) {
        // B 站在签名无效时返回 -352（HTTP 200）
        return new Response(
          JSON.stringify({ code: -352, message: '风控' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // V0.1.2：降级目标是 legacy /x/space/arc/search（不带 wbi 前缀）
      if (u.includes('/x/space/arc/search')) {
        return new Response(
          JSON.stringify({ code: -352, message: '风控' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    const c = new VideoCollector();
    const r = await c.collect({ targetId: '6666666' });
    // nav 失败 → WBI 不可用 → 应当直接走 legacy arc/search
    expect(calls_log.some((u) => u.includes('x/web-interface/nav'))).toBe(true);
    expect(calls_log.some((u) => u.includes('/x/space/arc/search'))).toBe(true);
    const legacyCall = calls_log.find((u) => u.includes('/x/space/arc/search'))!;
    expect(legacyCall).toMatch(/[?&]mid=6666666/);
    expect(legacyCall).not.toContain('w_rid');
    // data 为空，collect 视为成功（无视频可收集不是错误）
    if (r.ok) {
      expect(r.data).toHaveLength(0);
    }
  }, 15000);

  // V0.1.2（P0-2）：这是原实现最大的漏洞 —— 签名成功但 B 站返回 code=-352（HTTP 200）
  // 时不会抛异常，原实现会直接把 -352 当成成功结果。现在必须触发降级。
  it('WBI 接口返回 -352（HTTP 200）时也要降级到 legacy', async () => {
    await db.creators.add(
      creatorSchema.parse({
        id: 'cr_seed3',
        uid: 5555555,
        name: 'seed3',
        avatar: undefined,
        sign: '',
        level: 0,
        followers: 0,
        following: 0,
        videoCount: 0,
        spaceUrl: 'https://space.bilibili.com/5555555/',
        lastCollectedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'manual',
      }),
    );

    const calls_log: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls_log.push(u);
      if (u.includes('x/web-interface/nav')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // WBI 接口签名"成功"但被风控：HTTP 200 + code=-352
      if (u.includes('wbi/arc/search')) {
        return new Response(
          JSON.stringify({ code: -352, message: '风控' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('/x/space/arc/search')) {
        return new Response(
          JSON.stringify({ code: 0, data: { list: { vlist: [] } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    const c = new VideoCollector();
    const r = await c.collect({ targetId: '5555555' });

    // 关键：wbi/arc/search 被调用过（带 w_rid），随后 legacy 也被调用过
    const wbiCall = calls_log.find((u) => u.includes('wbi/arc/search'));
    expect(wbiCall).toBeTruthy();
    expect(wbiCall).toContain('w_rid=');
    expect(calls_log.some((u) => u.includes('/x/space/arc/search'))).toBe(true);
    expect(r.ok).toBe(true);
  }, 15000);
});