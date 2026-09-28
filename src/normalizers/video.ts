/**
 * Video normalizer.
 * - listVideos 返回结构里 `vlist` 数组（archive API） 或 `data.list.vlist`
 * - 单视频详情需要 stat 接口合并数据
 *
 * V0.1.1 修复：
 *   - `duration` 字段在 archive API 是 number（秒），在搜索接口是 string（"MM:SS" / "HH:MM:SS"）。
 *     rawVideoSchema 用 z.union 兼容，并在 normalizeVideoList 里 coerce 到 number。
 */

import { z } from 'zod';
import { videoSchema, type Video } from '@models/video';
import { newId } from '@utils/id';
import { nowIso, secondsToIso } from '@utils/time';
import type { Source } from '@models/common';

/**
 * 兼容多种 duration 表示：number、numeric string、"MM:SS"、"HH:MM:SS"。
 *
 * V0.1.3（P0-3）：返回 `number | null`。
 *   真实投稿列表用的是 `length`（"12:34"），旧实现只读 `duration`，
 *   缺失时返回 0 —— 于是页面上「全部 0s」看起来像真实数据。
 *   现在：解析不出来一律 null（未知），只有真实 0 才返回 0。
 */
export function parseDurationToSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
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
  return null;
}

/**
 * 发布时间：投稿列表用 `created`，详情/搜索用 `pubdate`。
 * 返回 null 表示未知 —— 不允许退回 Date.now()（那会让所有视频显示成"今天"）。
 */
export function parsePubTimeToIso(raw: Record<string, unknown>): string | null {
  const candidates = ['created', 'pubdate', 'ctime', 'senddate', 'pub_time'];
  for (const key of candidates) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return secondsToIso(Math.floor(v));
    if (typeof v === 'string' && /^\d{9,11}$/.test(v.trim())) return secondsToIso(Number(v.trim()));
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return null;
}

/** 播放量：投稿列表/搜索用 `play`，详情用 `view` / `click` */
export function parseViews(raw: Record<string, unknown>): number | null {
  const candidates = ['play', 'view', 'click'];
  for (const key of candidates) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

/** UP 主：列表/搜索用 `author` + `mid`，详情用 `owner.name` + `owner.mid` */
export function parseAuthor(raw: Record<string, unknown>): {
  authorName?: string;
  authorMid?: number;
} {
  const out: { authorName?: string; authorMid?: number } = {};
  const nameRaw = raw.author ?? (raw.owner as { name?: unknown } | undefined)?.name;
  const midRaw = raw.mid ?? (raw.owner as { mid?: unknown } | undefined)?.mid;
  if (typeof nameRaw === 'string' && nameRaw.trim()) out.authorName = nameRaw.trim();
  if (typeof midRaw === 'number' && midRaw > 0) out.authorMid = midRaw;
  return out;
}

const rawVideoSchema = z
  .object({
    bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
    aid: z.number().int().nonnegative(),
    title: z.string().default(''),
    desc: z.string().default(''),
    pic: z.string().default(''),
    pubdate: z.number().int().nonnegative().default(0),
    // 兼容 number | numeric string | "MM:SS"；最终在 normalizeVideoList 里 coerce
    duration: z
      .union([z.number(), z.string()])
      .transform(() => 0) // 占位，真实值在 normalizeVideoList 通过 parseDurationToSeconds 设置
      .optional(),
    tname: z.string().default(''),
    tag: z.string().default(''),
    // 搜索接口可能没有 tname，但有 tag_list；非破坏性 passthrough
  })
  .passthrough();

interface BiliResp {
  code?: number;
  message?: string;
  data?: unknown;
}

function extractList(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as BiliResp;
  if (typeof r.code === 'number' && r.code !== 0) return [];
  const d = r.data;
  if (!d || typeof d !== 'object') return [];
  const dd = d as Record<string, unknown>;
  if (Array.isArray(dd.vlist)) return dd.vlist;
  if (dd.list && typeof dd.list === 'object') {
    const list = dd.list as Record<string, unknown>;
    if (Array.isArray(list.vlist)) return list.vlist;
  }
  return [];
}

export function normalizeVideoList(
  raw: unknown,
  opts: { creatorId: string; source?: Source; now?: string },
): Video[] {
  const now = opts.now ?? nowIso();
  const list = extractList(raw);
  const out: Video[] = [];
  for (const item of list) {
    const parsed = rawVideoSchema.safeParse(item);
    if (!parsed.success) continue;
    const v = parsed.data;
    const tags = v.tag
      ? v.tag
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const cover = isValidUrl(v.pic) ? v.pic : undefined;
    const rest = item as Record<string, unknown>;
    // V0.1.3（P0-3）：真实投稿列表字段是 length / created / play / author / mid，
    // 这里按优先级取候选字段，全部缺失时为 null（未知），不制造 0 / 当前时间。
    const durationSec = parseDurationToSeconds(rest.length ?? rest.duration);
    const pubTime = parsePubTimeToIso(rest);
    const views = parseViews(rest) ?? undefined;
    const { authorName, authorMid } = parseAuthor(rest);
    const candidate = {
      id: newId('vd'),
      bvid: v.bvid,
      aid: v.aid,
      creatorId: opts.creatorId,
      title: v.title,
      description: typeof rest.description === 'string' ? rest.description : v.desc,
      cover,
      pubTime,
      duration: durationSec,
      category: typeof rest.typename === 'string' && rest.typename ? rest.typename : v.tname,
      authorName,
      authorMid,
      views,
      tags,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      createdAt: now,
      updatedAt: now,
      source: opts.source ?? 'bili-api',
    };
    const final = videoSchema.safeParse(candidate);
    if (final.success) out.push(final.data);
  }
  return out;
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

/**
 * `/x/web-interface/view` 详情响应结构（V0.2.2）。
 *
 * 与列表接口的差异：
 *   - 详情用 `desc` / `pic` / `pubdate` / `duration`（秒）/ `tname`，
 *     没有列表的 `tag`（用 `dynamic`/`desc` 之外还有一个 `tname`，标签需另接口）。
 *   - UP 主在 `owner.mid` / `owner.name` / `owner.face`（列表是顶层 `mid` / `author`）。
 *   - 指标在 `stat.view/like/coin/favorite/share/reply/danmaku`。
 *
 * 之所以不复用 `rawVideoSchema`：那份 schema 针对列表（`z.string().default('')` 的
 * title/tag 等），把详情硬塞进去会强行把缺失字段默认成空串，违背「unknown ≠ 默认值」。
 * 这里单独建 schema，但**字段解析全部复用** `parseDurationToSeconds` /
 * `parsePubTimeToIso` / `parseViews` / `parseAuthor`，不重复实现。
 */
const videoDetailSchema = z
  .object({
    bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
    aid: z.number().int().positive(),
    title: z.string(),
    desc: z.string().optional(),
    pic: z.string().optional(),
    pubdate: z.number().int().optional(),
    duration: z.union([z.number(), z.string()]).optional(),
    tname: z.string().optional(),
    owner: z
      .object({
        mid: z.union([z.number(), z.string()]).optional(),
        name: z.string().optional(),
        face: z.string().optional(),
      })
      .passthrough()
      .optional(),
    stat: z
      .object({
        view: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface VideoDetailResult {
  video: Video;
  /** UP 主最小信息（用于建立 / 复用最小 Creator 记录）；缺失时为 null，绝不伪造 */
  owner: { uid: number; name: string; avatar?: string } | null;
}

/**
 * 归一化 `/x/web-interface/view` 的 **成功响应**（调用方须先确认 `code===0 && data`）。
 *
 * 返回 `null` 表示结构非法（缺 bvid / aid 等关键字段），**不得写入脏数据**。
 * 未知值语义：duration 解析不出 → null；pubTime 缺失 → null（绝不回退 `Date.now()`）；
 * views 缺失 → undefined（UI 显示 –）。
 */
export function normalizeVideoDetail(
  raw: unknown,
  opts: { creatorId: string; source?: Source; now?: string },
): VideoDetailResult | null {
  const now = opts.now ?? nowIso();
  const parsed = videoDetailSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const rest = d as unknown as Record<string, unknown>;
  const cover = isValidUrl(d.pic) ? d.pic : undefined;
  const { authorName, authorMid } = parseAuthor(rest);

  const ownerRaw = d.owner;
  let owner: VideoDetailResult['owner'] = null;
  if (ownerRaw) {
    const uidNum = typeof ownerRaw.mid === 'number' ? ownerRaw.mid : Number(ownerRaw.mid);
    const name = typeof ownerRaw.name === 'string' ? ownerRaw.name.trim() : '';
    if (Number.isFinite(uidNum) && uidNum > 0 && name) {
      owner = {
        uid: Math.floor(uidNum),
        name,
        ...(isValidUrl(ownerRaw.face) ? { avatar: ownerRaw.face } : {}),
      };
    }
  }

  const candidate = {
    id: newId('vd'),
    bvid: d.bvid,
    aid: d.aid,
    creatorId: opts.creatorId,
    title: d.title.trim() || d.bvid,
    description: typeof d.desc === 'string' ? d.desc : '',
    cover,
    pubTime: parsePubTimeToIso(rest),
    duration: parseDurationToSeconds(rest.duration),
    category: typeof d.tname === 'string' && d.tname ? d.tname : '',
    authorName,
    authorMid,
    views: d.stat?.view ?? parseViews(rest) ?? undefined,
    tags: [],
    url: `https://www.bilibili.com/video/${d.bvid}`,
    createdAt: now,
    updatedAt: now,
    source: opts.source ?? 'bili-api',
  };
  const final = videoSchema.safeParse(candidate);
  if (!final.success) return null;
  return { video: final.data, owner };
}


const statRespSchema = z
  .object({
    code: z.number().int().default(0),
    message: z.string().default(''),
    data: z
      .object({
        bvid: z.string(),
        aid: z.number().int(),
        // V0.1.3：指标缺失 → null，不再 default(0)
        view: z.number().int().nonnegative().optional(),
        like: z.number().int().nonnegative().optional(),
        coin: z.number().int().nonnegative().optional(),
        favorite: z.number().int().nonnegative().optional(),
        share: z.number().int().nonnegative().optional(),
        reply: z.number().int().nonnegative().optional(),
        danmaku: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface VideoStat {
  bvid: string;
  aid: number;
  views: number | null;
  likes: number | null;
  coins: number | null;
  favorites: number | null;
  shares: number | null;
  comments: number | null;
  danmaku: number | null;
}

export function normalizeVideoStat(raw: unknown): VideoStat | null {
  const parsed = statRespSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data) return null;
  const d = parsed.data.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    views: d.view ?? null,
    likes: d.like ?? null,
    coins: d.coin ?? null,
    favorites: d.favorite ?? null,
    shares: d.share ?? null,
    comments: d.reply ?? null,
    danmaku: d.danmaku ?? null,
  };
}