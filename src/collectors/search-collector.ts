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
import { secondsToIso } from '@utils/time';
import { BILI_REFERRER, biliCode, isBiliBlocked } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
import { videoSchema, type Video } from '@models/video';
import type { Collector, CollectorInput, CollectorResult } from './types';

interface BiliSearchResp {
  code?: number;
  message?: string;
  ttl?: number;
  data?: {
    result?: { video?: unknown[] };
    page?: number;
    numResults?: number;
  };
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

/** 解析搜索结果里 "MM:SS" / "HH:MM:SS" 字符串为秒 */
export function parseSearchDuration(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return 0;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.floor(Number(s)));
    if (s.includes(':')) {
      const parts = s.split(':').map((p) => Number(p.trim()));
      if (parts.every((p) => Number.isFinite(p) && p >= 0)) {
        let total = 0;
        for (const p of parts) total = total * 60 + p;
        return Math.max(0, Math.floor(total));
      }
    }
  }
  return 0;
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
  const authorMid = typeof r.mid === 'number' && r.mid > 0 ? r.mid : undefined;
  const authorName = typeof r.author === 'string' && r.author.trim() ? r.author.trim() : undefined;
  const views = typeof r.play === 'number' && Number.isFinite(r.play) && r.play >= 0 ? r.play : undefined;

  const candidate = {
    id: newId('vd'),
    bvid: r.bvid,
    aid: r.aid,
    creatorId: authorMid ? `uid:${authorMid}` : 'search',
    title: title.slice(0, 500),
    description: (r.description ?? '').slice(0, 5000),
    cover: isValidUrl(r.pic) ? r.pic : undefined,
    pubTime: secondsToIso(typeof r.pubdate === 'number' ? r.pubdate : Math.floor(Date.now() / 1000)),
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
): Promise<{ signedUrl: string | null; plainUrl: string }> {
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
    const query = await buildWbiQuery(base);
    return { signedUrl: `${SEARCH_ENDPOINT}?${query}`, plainUrl };
  } catch (e) {
    logger.warn(`search WBI sign failed, use unsigned url: ${e instanceof Error ? e.message : e}`);
    return { signedUrl: null, plainUrl };
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
      const { signedUrl, plainUrl } = await buildSearchUrls(keyword, page, 20);
      const opts = { signal: input.signal, referrer: BILI_REFERRER.search };

      let res = await httpGet<BiliSearchResp>(signedUrl ?? plainUrl, opts);
      // WBI 签名被判无效（HTTP 200 + code != 0）时用未签名 URL 再试一次
      if (signedUrl && isBiliBlocked(res) && biliCode(res) !== 0) {
        logger.warn(`search/type WBI 请求被拦（code=${biliCode(res)}），回退未签名 URL`);
        res = await httpGet<BiliSearchResp>(plainUrl, opts);
      }

      const code = biliCode(res);
      if (code !== 0) {
        return {
          ok: false,
          error: `search code=${code ?? 'n/a'} msg=${res.message ?? ''}`,
          retryable: false,
        };
      }
      const list = normalizeSearchVideoList(res.data?.result?.video ?? []);
      logger.info(`SearchCollector keyword="${keyword}" page=${page} got ${list.length}`);
      return { ok: true, data: list, fetched: true, stats: { added: list.length, updated: 0, unchanged: 0 } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}