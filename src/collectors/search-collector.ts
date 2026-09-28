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

  const candidate = {
    id: newId('vd'),
    bvid: r.bvid,
    aid: r.aid,
    creatorId: 'search',
    title: title.slice(0, 500),
    description: (r.description ?? '').slice(0, 5000),
    cover: isValidUrl(r.pic) ? r.pic : undefined,
    pubTime: secondsToIso(typeof r.pubdate === 'number' ? r.pubdate : Math.floor(Date.now() / 1000)),
    duration: parseSearchDuration(r.duration),
    category: '', // 搜索接口不返回 tname
    tags: tags.slice(0, 50).map((t) => t.slice(0, 50)),
    url: `https://www.bilibili.com/video/${r.bvid}`,
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

export class SearchCollector implements Collector<Video> {
  readonly name = 'search';

  async collect(input: CollectorInput): Promise<CollectorResult<Video>> {
    const keyword = input.targetId.trim();
    if (!keyword) {
      return { ok: false, error: 'empty keyword', retryable: false };
    }
    const page = Number(input.context?.page ?? 1);
    try {
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
        keyword,
      )}&page=${page}&page_size=20&order=pubdate&platform=web&web_location=40020`;
      const res = await httpGet<BiliSearchResp>(url, { signal: input.signal });
      if (res.code !== 0) {
        return { ok: false, error: `search code=${res.code} msg=${res.message ?? ''}`, retryable: false };
      }
      const list = normalizeSearchVideoList(res.data?.result?.video ?? []);
      logger.info(`SearchCollector keyword="${keyword}" page=${page} got ${list.length}`);
      return { ok: true, data: list, fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}