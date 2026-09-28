/**
 * WBI 签名回归测试（P0-1）
 * 重点：w_rid 必须是真正的 MD5，且签名用的 query 与请求 URL 的 query 字节一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetWbiForTest, buildWbiQuery, refreshWbi, signWbi } from '@utils/wbi';
import { md5 } from '@utils/md5';

const NAV_RESP = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

function mockNav(): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(NAV_RESP), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('wbi', () => {
  beforeEach(() => {
    __resetWbiForTest();
    mockNav();
  });
  afterEach(() => {
    __resetWbiForTest();
    vi.restoreAllMocks();
  });

  it('refreshWbi 用 img_key + sub_key 拼出 32 位 mixin key', async () => {
    await refreshWbi();
    // 官方算法：两个 32 位文件名拼接后按表重排再截 32 位
    const raw = '7cd084941338484aae1ad9425b84077c' + '4932caff0ff746eab6f01bf08b70ac45';
    const expected = [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
      28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
      54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ]
      .map((i) => raw[i] ?? '')
      .join('')
      .slice(0, 32);
    const signed = await signWbi({ mid: 1 });
    // 反推签名：w_rid 应等于 md5(query + mixinKey)
    const entries = Object.entries({ mid: 1, wts: signed.wts })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    expect(signed.w_rid).toBe(md5(entries + expected));
    expect(signed.w_rid).toHaveLength(32);
  });

  it('buildWbiQuery 生成的 query 与签名同源（w_rid 可复现）', async () => {
    await refreshWbi();
    const q = await buildWbiQuery({ mid: 42, pn: 1, ps: 30 });
    expect(q).toContain('w_rid=');
    expect(q).toContain('wts=');
    // 参数按键名排序：mid < pn < ps < wts
    expect(q.indexOf('mid=')).toBeLessThan(q.indexOf('pn='));
    expect(q.indexOf('pn=')).toBeLessThan(q.indexOf('ps='));
    // w_rid 必须挂在最后，且其值为 32 位 hex
    const rid = q.slice(q.lastIndexOf('w_rid=') + 6);
    expect(rid).toMatch(/^[0-9a-f]{32}$/);
    // 复算：去掉 &w_rid=xxx 后用 md5 校验
    const base = q.slice(0, q.lastIndexOf('&w_rid='));
    const signed = await signWbi({ mid: 42, pn: 1, ps: 30 });
    expect(signed.w_rid).toBe(md5(base + (await import('@utils/wbi')).loadCachedMixinKey()));
  });

  it('value 中的 !\'()* 会被过滤（与官方实现一致）', async () => {
    await refreshWbi();
    const q = await buildWbiQuery({ keyword: "a'b(c)*d!" });
    expect(q).not.toContain("'");
    expect(q).not.toContain('(');
    expect(q).not.toContain('*');
    expect(q).toContain('keyword=a');
  });

  it('未 refresh 时签名抛错（调用方据此降级）', async () => {
    await expect(buildWbiQuery({ mid: 1 })).rejects.toThrow(/mixin key not loaded/);
  });

  it('nav 无 wbi_img 时 refreshWbi 抛错', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(refreshWbi()).rejects.toThrow(/missing wbi_img/);
  });
});
