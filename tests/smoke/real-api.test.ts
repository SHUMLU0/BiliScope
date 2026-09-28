/**
 * 真实 API smoke test（结构层）
 *
 * 运行方式（**已从常规 CI 中剥离**）：
 *   pnpm test:smoke   # 手动验证真实 B 站链路
 *   pnpm test         # 常规单元测试，完全离线
 *
 * V0.1.3（P1-Smoke 语义）：结论只有三种 —— PASS / PASS_WITH_ENV_LIMIT / FAIL。
 * 「真实 API 因 B 站风控拿不到数据」必须记为 PASS_WITH_ENV_LIMIT，
 * 绝不能包装成 PASS。
 */

import { describe, expect, it } from 'vitest';
import { extractSearchVideos, normalizeSearchVideoList } from '@collectors/search-collector';
import { normalizeVideoStat, parseDurationToSeconds } from '@normalizers/video';
import { normalizeNavnum, normalizeRelationStat } from '@normalizers/creator';
import { httpGet } from '@utils/http';
import { BILI_REFERRER, biliCode } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
import { assertNotFail, classifyBili } from './classify';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UID = 946974;

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
    'nav 返回 wbi_img（WBI 签名链路依赖）',
    async () => {
      const { status, json } = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
      expect(status).toBe(200);
      const obj = json as { code?: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
      const structureOk = typeof obj.code === 'number';
      const verdict = structureOk && obj.code === 0 && obj.data?.wbi_img ? 'PASS' : structureOk ? 'PASS_WITH_ENV_LIMIT' : 'FAIL';
      assertNotFail(
        verdict,
        `nav code=${obj.code} hasWbiImg=${Boolean(obj.data?.wbi_img)}`,
      );
    },
    30_000,
  );

  it(
    'WBI 签名（真实 MD5）对 space 接口：对照组已知被风控时记为环境限制',
    async () => {
      await refreshWbi();
      const query = await buildWbiQuery({ mid: UID, token: '' });
      expect(query).toMatch(/w_rid=[0-9a-f]{32}$/);

      const wbiRes = await httpGet<{ code?: number }>(
        `https://api.bilibili.com/x/space/wbi/acc/info?${query}`,
        { referrer: BILI_REFERRER.space(UID), retries: 0 },
      ).catch(() => ({ code: null }));
      // 对照组：完全不需要签名的 legacy 接口
      const legacyRes = await httpGet<{ code?: number }>(
        `https://api.bilibili.com/x/space/acc/info?mid=${UID}`,
        { referrer: BILI_REFERRER.space(UID), retries: 0 },
      ).catch(() => ({ code: null }));

      const verdict = classifyBili({
        code: biliCode(wbiRes),
        hasData: Boolean((wbiRes as { data?: unknown }).data),
        legacyCode: biliCode(legacyRes),
        structureOk: true,
      });
      assertNotFail(verdict, `wbi/acc/info code=${biliCode(wbiRes)}，legacy code=${biliCode(legacyRes)}`);
    },
    30_000,
  );

  it(
    'relation/stat + navnum 是匿名可用的真实粉丝 / 关注 / 投稿来源',
    async () => {
      const rel = await httpGet<unknown>(
        `https://api.bilibili.com/x/relation/stat?vmid=${UID}`,
        { referrer: BILI_REFERRER.space(UID), retries: 0 },
      ).catch(() => null);
      const nav = await httpGet<unknown>(
        `https://api.bilibili.com/x/space/navnum?mid=${UID}`,
        { referrer: BILI_REFERRER.space(UID), retries: 0 },
      ).catch(() => null);

      const r = normalizeRelationStat(rel);
      const n = normalizeNavnum(nav);
      const structureOk = true;
      const hasData = r.followers !== null && n.videoCount !== null;
      const verdict = classifyBili({
        code: biliCode(rel),
        hasData,
        legacyCode: biliCode(nav),
        structureOk,
      });
      assertNotFail(
        verdict,
        `relation/stat follower=${r.followers} following=${r.following}；navnum video=${n.videoCount}`,
      );
    },
    30_000,
  );

  it(
    'search/type（WBI 签名）返回真实视频数组，字段可归一化',
    async () => {
      await refreshWbi();
      const query = await buildWbiQuery({
        search_type: 'video',
        keyword: '影视飓风',
        page: 1,
        page_size: 5,
        order: 'pubdate',
        platform: 'web',
        web_location: 40020,
      });
      const res = await httpGet<unknown>(
        `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,
        { referrer: BILI_REFERRER.search, retries: 0 },
      ).catch(() => null);
      const items = extractSearchVideos(res);
      const list = normalizeSearchVideoList(items);
      const first = list[0];
      const hasData = list.length > 0;
      const verdict = classifyBili({
        code: biliCode(res),
        hasData,
        // 对照组：未签名同端点
        legacyCode: biliCode(
          await httpGet<unknown>(
            `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
              '影视飓风',
            )}&page=1&page_size=5`,
            { referrer: BILI_REFERRER.search, retries: 0 },
          ).catch(() => null),
        ),
        structureOk: true,
      });
      assertNotFail(
        verdict,
        `search got=${list.length} first={up:${first?.authorName}, play:${first?.views}, duration:${
          first?.duration
        }, pubTime:${first?.pubTime}}`,
      );
      if (hasData) {
        // 真实字段必须保留（P1-Search）
        expect(typeof first?.authorName).toBe('string');
        expect(typeof first?.views).toBe('number');
        if (items[0] && typeof (items[0] as { duration?: unknown }).duration === 'string') {
          expect(parseDurationToSeconds((items[0] as { duration: unknown }).duration)).toBeGreaterThan(0);
        }
      }
    },
    30_000,
  );

  it(
    'view 单视频接口返回真实 stat（pubdate / duration / stat）',
    async () => {
      const { status, json } = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7');
      expect(status).toBeLessThan(500);
      const obj = json as { code?: number; data?: Record<string, unknown> };
      const stat = normalizeVideoStat(obj);
      const verdict = classifyBili({
        code: biliCode(obj),
        hasData: Boolean(stat),
        legacyCode: biliCode(obj),
        structureOk: true,
      });
      assertNotFail(verdict, `view views=${stat?.views} likes=${stat?.likes}`);
    },
    30_000,
  );
});
