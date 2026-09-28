/**
 * SearchCollector
 * 用于全站雷达 / 灵感：基于公开搜索接口。
 *
 * 入口：collect({ targetId: keyword, context: { page } })
 *
 * V0.1.1 修复（独立验收反馈 · 真实搜索响应结构）：
 *   真实响应：`data.result.video[]`，每项字段与 archive API 不同：
 *     - title: HTML escaped（带 <em class="keyword">…</em> 包裹关键词）
 *     - 没有 desc 字段，使用 description
 *     - 没有 tname（category），置空
 *     - duration 是 "MM:SS" 字符串而非 number
 *     - views 来自 play 字段（archive API 用 view）
 *     - mid 是 UP 中图    uid，author 是 UP 名字
 *     - tag 是 "tag1,tag2" 字符串（同 archive API），保留
 *     - pic 是 cover URL
 *
 *   为此新增 normalizeSearchVideoList，避免污染 archive normalizer。
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';
import { nowIso } from '@utils/time';
import { newId } from '@utils/id';
import { BILI_REFERRER, biliCode, isBiliBlocked } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
import { videoSchema, type Video } from '@models/video';
import { parseAuthor, parseDurationToSeconds, parsePubTimeToIso, parseViews } from '@normalizers/video';
import type { Collector, CollectorInput, CollectorResult } from './types';

interface BiliSearchResp {
  code?: number;
  message?: string;
  ttl?: number;
  data?: {
    /**
     * 真实响应（2026-09 实机抓取，见 tests/fixtures/real/search-type-wbi.json）：
     * `data.result` 是 **数组**，不是 `{ video: [] }`。
     * 旧实现只读 `data.result.video`，在无 WBI / 新版接口下拿到 0 条。
     */
    result?: unknown[] | { video?: unknown[] };
    page?: number;
    numResults?: number;
    numPages?: number;
  };
}

/** 从搜索响应里取出视频数组，兼容 result 为数组 / { video: [] } 两种真实形态 */
export function extractSearchVideos(raw: unknown): unknown[] {
  const data = (raw as BiliSearchResp | undefined)?.data;
  const r = data?.result;
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && Array.isArray(r.video)) return r.video;
  return [];
}

function isValidUrl(s: string | undefined | null): s is string {
  if (!s) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** B 站搜索结果 title 带 <em class="keyword">xxx</em>，剥离为纯文本 */
export function stripSearchHighlight(html: string): string {
  if (!html) return '';
  return html
    .replace(/<em[^>]*>/g, '')
    .replace(/<\/em>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * 解析搜索结果里 "MM:SS" / "HH:MM:SS" 字符串为秒。
 * V0.1.3（P0-3）：与投稿列表统一 —— 解析不出来返回 null（未知），不再伪装成 0s。
 */
export function parseSearchDuration(raw: unknown): number | null {
  return parseDurationToSeconds(raw);
}

interface RawSearchVideo {
  bvid?: string;
  aid?: number;
  title?: string;
  description?: string;
  pic?: string;
  pubdate?: number;
  duration?: unknown;
  play?: number;
  mid?: number;
  author?: string;
  tag?: string;
  tag_list?: string[];
}

/** 把单条搜索结果归一化为 Video（不依赖 normalizeVideoList） */
export function normalizeSearchVideo(raw: unknown, opts: { now?: string } = {}): Video | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawSearchVideo;
  if (!r.bvid || !/^BV[0-9A-Za-z]{10}$/.test(r.bvid)) return null;
  if (typeof r.aid !== 'number' || r.aid < 0) return null;

  const now = opts.now ?? nowIso();
  const title = stripSearchHighlight(r.title ?? '');
  if (!title) return null;

  // 标签：tag 字符串优先（与 archive API 一致），其次 tag_list 数组
  let tags: string[] = [];
  if (typeof r.tag === 'string' && r.tag.trim()) {
    tags = r.tag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(r.tag_list)) {
    tags = r.tag_list.filter((s): s is string => typeof s === 'string');
  }

  // V0.1.2（P0-4）：UP 与播放信息必须保留，不能像之前那样整条丢掉。
  // creatorId 用稳定的 uid:{mid}（此前是字面量 'search'，导致 Radar 的 UP 列全是 search）
  const rest = raw as Record<string, unknown>;
  const { authorName, authorMid } = parseAuthor(rest);
  const views = parseViews(rest) ?? undefined;

  const candidate = {
    id: newId('vd'),
    bvid: r.bvid,
    aid: r.aid,
    creatorId: authorMid ? `uid:${authorMid}` : 'search',
    title: title.slice(0, 500),
    description: (r.description ?? '').slice(0, 5000),
    cover: isValidUrl(r.pic) ? r.pic : undefined,
    // V0.1.3：拿不到 pubdate 就是 null，不退回 Date.now()
    pubTime: parsePubTimeToIso(rest),
    duration: parseSearchDuration(r.duration),
    category: '', // 搜索接口不返回 tname
    tags: tags.slice(0, 50).map((t) => t.slice(0, 50)),
    url: `https://www.bilibili.com/video/${r.bvid}`,
    authorName,
    authorMid,
    views,
    createdAt: now,
    updatedAt: now,
    source: 'bili-web' as const,
  };
  const parsed = videoSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data;
}

export function normalizeSearchVideoList(raw: unknown): Video[] {
  const list = (raw ?? []) as unknown[];
  const out: Video[] = [];
  for (const item of list) {
    const v = normalizeSearchVideo(item);
    if (v) out.push(v);
  }
  return out;
}

/**
 * 搜索端点（2026-09-28 实机验证，见 tests/fixtures/real/）：
 *   - `https://api.bilibili.com/x/web-interface/wbi/search/type`  —— 当前维护资料中的新版分类搜索入口，需 WBI 签名（wts + w_rid）
 *   - `https://api.bilibili.com/x/web-interface/search/type`      —— 旧入口，目前仍可用，同样需要 WBI 签名（实测未签名会 412）
 * 认证方式：匿名 + WBI 签名 + bilibili 域 referrer，不用 Cookie。
 * 失败降级：wbi 端点被拦 → 旧端点（签名）→ 旧端点（未签名）→ 返回错误（不伪造数据）。
 */
const SEARCH_ENDPOINT_WBI = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const SEARCH_ENDPOINT = 'https://api.bilibili.com/x/web-interface/search/type';

function encodeQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * 构造搜索 URL。
 * V0.1.2（P0-3）：
 *   1. 请求必须带 bilibili 域的 referrer，否则真实 Chrome 里直接 412；
 *   2. search/type 现已纳入 WBI 签名，用 P0-1 的真实 MD5 生成 w_rid；签名失败才退回未签名 URL。
 */
async function buildSearchUrls(
  keyword: string,
  page: number,
  pageSize: number,
): Promise<{ urls: string[] }> {
  const base: Record<string, string | number> = {
    search_type: 'video',
    keyword,
    page,
    page_size: pageSize,
    order: 'pubdate',
    platform: 'web',
    web_location: 40020,
  };
  const plainUrl = `${SEARCH_ENDPOINT}?${encodeQuery(base)}`;
  try {
    await refreshWbi();
    const queryWbi = await buildWbiQuery(base);
    const querySigned = await buildWbiQuery(base);
    return {
      urls: [`${SEARCH_ENDPOINT_WBI}?${queryWbi}`, `${SEARCH_ENDPOINT}?${querySigned}`, plainUrl],
    };
  } catch (e) {
    logger.warn(`search WBI sign failed, use unsigned url: ${e instanceof Error ? e.message : e}`);
    return { urls: [plainUrl] };
  }
}

export class SearchCollector implements Collector<Video> {
  readonly name = 'search';

  async collect(input: CollectorInput): Promise<CollectorResult<Video>> {
    const keyword = input.targetId.trim();
    if (!keyword) {
      return { ok: false, error: 'empty keyword', retryable: false };
    }
    const page = Number(input.context?.page ?? 1);
    try {
      const { urls } = await buildSearchUrls(keyword, page, 20);
      const opts = { signal: input.signal, referrer: BILI_REFERRER.search };

      // 依次尝试：wbi/search/type(签名) → search/type(签名) → search/type(未签名)
      let res: BiliSearchResp | null = null;
      for (const [i, url] of urls.entries()) {
        try {
          const r = await httpGet<BiliSearchResp>(url, opts);
          res = r;
          const code = biliCode(r);
          if (code === 0 && extractSearchVideos(r).length > 0) {
            logger.debug(`search via url#${i} ok, ${extractSearchVideos(r).length} items`);
            break;
          }
          logger.warn(`search url#${i} 不可用（code=${code ?? 'n/a'}），尝试下一个端点`);
        } catch (e) {
          logger.warn(`search url#${i} 请求失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!res) {
        return { ok: false, error: 'search: all endpoints failed', retryable: true };
      }
      const code = biliCode(res);
      if (code !== 0) {
        return {
          ok: false,
          error: `search code=${code ?? 'n/a'} msg=${res.message ?? ''}`,
          retryable: false,
        };
      }
      if (isBiliBlocked(res)) {
        return { ok: false, error: `search blocked code=${code ?? 'n/a'}`, retryable: false };
      }
      const list = normalizeSearchVideoList(extractSearchVideos(res));
      logger.info(`SearchCollector keyword="${keyword}" page=${page} got ${list.length}`);
      return { ok: true, data: list, fetched: true, stats: { added: list.length, updated: 0, unchanged: 0 } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}