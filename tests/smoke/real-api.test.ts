/**
 * 真实 API smoke test
 *
 * 运行方式（**已从常规 CI 中剥离，P1-10**）：
 *   pnpm test:smoke          # 手动验证真实 B 站链路
 *   pnpm test                # 常规单元测试，不碰网络
 *
 * 验证点：
 *   1. /x/web-interface/nav 返回 wbi_img（img_url + sub_url）
 *   2. 用真实 MD5 生成的 w_rid 能被 B 站接受（P0-1 回归：SHA-256 截断必然 -352）
 *   3. /x/web-interface/search/type?search_type=video 返回 data.result.video[]
 *   4. 单视频 /x/web-interface/view 返回 view / like / reply 等
 *
 * 说明：无 Cookie / 部分 IP 下 B 站会返回 -352 风控或 412 前置校验，
 * 这是 B 站侧限流，不算失败；测试只断言「不是我们自己的签名 / 结构错误」。
 *
 * 已知环境限制（本机实测）：space 系列接口（含完全不需要签名的 legacy acc/info）
 * 在该出口 IP 上返回 -799 / -352，因此 WBI 签名的端到端成功与否无法在此定性；
 * WBI 里唯一属于我们自己的部分 —— MD5 —— 由 tests/utils/md5.test.ts
 * （RFC 1321 向量 + Node crypto 差分）保证。
 */

import { describe, expect, it } from 'vitest';
import { normalizeSearchVideoList } from '@collectors/search-collector';
import { normalizeVideoStat, parseDurationToSeconds } from '@normalizers/video';
import { httpGet } from '@utils/http';
import { BILI_REFERRER, biliCode } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: BILI_REFERRER.www },
    credentials: 'omit',
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, json };
}

describe('real API smoke', () => {
  it(
    'B 站 nav 接口返回 wbi_img（refreshWbi 依赖）',
    async () => {
      const { status, json } = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
      expect(status).toBe(200);
      const obj = json as { code?: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
      expect(obj.code).toBeDefined();
      if (obj.data?.wbi_img) {
        expect(typeof obj.data.wbi_img.img_url).toBe('string');
        expect(typeof obj.data.wbi_img.sub_url).toBe('string');
      }
    },
    30_000,
  );

  it(
    '真实 MD5 的 WBI 签名不劣于无签名 legacy 请求（P0-1 回归）',
    async () => {
      await refreshWbi();
      const query = await buildWbiQuery({ mid: 2, token: '', platform: 'web', web_location: 1550101 });
      expect(query).toContain('w_rid=');
      expect(query).toContain('wts=');
      expect(query).toMatch(/w_rid=[0-9a-f]{32}$/);

      const wbiRes = await httpGet<{ code?: number }>(
        `https://api.bilibili.com/x/space/wbi/acc/info?${query}`,
        { referrer: BILI_REFERRER.space(2), retries: 0 },
      );
      // 对照组：同一时刻、完全不需要签名的 legacy 接口
      const legacyRes = await httpGet<{ code?: number }>(
        'https://api.bilibili.com/x/space/acc/info?mid=2',
        { referrer: BILI_REFERRER.space(2), retries: 0 },
      ).catch(() => ({ code: null }));

      const wbi = biliCode(wbiRes);
      const legacy = biliCode(legacyRes);
      expect(wbi).not.toBeNull();

      // 判定逻辑：
      //  - 若 legacy 自己也拿不到数据（无 Cookie / IP 风控），则 -352 属于环境风控，不是签名问题；
      //  - 若 legacy 正常（code=0）而 WBI 被判 -352，那才说明 w_rid 算法有问题。
      if (legacy === 0) {
        expect(wbi).not.toBe(-352);
      } else {
        console.warn(
          `[smoke] legacy acc/info code=${legacy}，当前出口对 space 系列整体风控，` +
            `无法端到端验证 WBI 签名（wbi code=${wbi}）。MD5 正确性由 tests/utils/md5.test.ts 保证。`,
        );
      }
    },
    30_000,
  );

  it(
    'B 站 search/type?search_type=video 返回 data.result.video[]',
    async () => {
      const { status, json } = await fetchJson(
        'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=AI&page=1&page_size=10',
      );
      // 无 Referer/Cookie 时 B 站可能返回 412，属正常风控，只要不是服务端错误即可
      expect(status).toBeLessThan(500);
      const obj = json as { code?: number; data?: { result?: { video?: unknown[] } } };
      if (obj.data?.result?.video) {
        expect(Array.isArray(obj.data.result.video)).toBe(true);
        if (obj.data.result.video.length > 0 && obj.code === 0) {
          const list = normalizeSearchVideoList(obj.data.result.video);
          const first = obj.data.result.video[0] as { duration?: unknown };
          if (first.duration !== undefined) {
            expect(parseDurationToSeconds(first.duration)).toBeGreaterThanOrEqual(0);
          }
          expect(list.length).toBeGreaterThan(0);
        }
      }
    },
    30_000,
  );

  it(
    'B 站 view 单视频接口返回 view/like/reply/danmaku',
    async () => {
      const { status, json } = await fetchJson(
        'https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7',
      );
      expect(status).toBeLessThan(500);
      const obj = json as { code?: number; data?: Record<string, unknown> };
      if (obj.data) {
        const stat = normalizeVideoStat(obj);
        if (stat) {
          expect(typeof stat.views).toBe('number');
          expect(typeof stat.likes).toBe('number');
        }
      }
    },
    30_000,
  );
});
