/**
 * Creator normalizer.
 * 容错：B 站 API 返回 `code / message / data` 三层结构；data 可能为 null；
 * 字段缺失时使用默认值，写入 rawData 保留原始对象。
 */

import { z } from 'zod';
import { creatorSchema, type Creator } from '@models/creator';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { biliCode } from '@utils/bili';
import type { Source } from '@models/common';

interface BiliApiResp {
  code?: number;
  message?: string;
  ttl?: number;
  data?: unknown;
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
 * V0.1.3（P0-1）：字段一律 optional，缺失 = null，不再 default(0)。
 * 真实 wbi/acc/info 给的是 `fans` / `attention`；旧版是 `fans` / `following`；
 * 投稿数在不同版本里是 `archive_count` / `archive.count` / `video_count`，
 * 不能假定任何一个一定存在。
 */
/**
 * 计数类字段在不同真实响应里可能是 number / 数字字符串 / 甚至布尔值
 * （`/x/web-interface/card` 的 `data.following` 是「是否已关注」的 boolean）。
 * 非数字一律视为「没给」→ undefined，最终落成 null。
 */
const numish = z
  .union([z.number(), z.string(), z.boolean(), z.null(), z.undefined()])
  .transform((v) => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
    return undefined;
  })
  .optional();

const cardDataSchema = z
  .object({
    // /x/web-interface/card 的 data.card.mid 是**字符串**（实机抓取确认），
    // acc/info 的是 number —— 两种都要能吃下。
    mid: z
      .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
      .transform((v) => Number(v)),
    name: z.string().default(''),
    face: z.string().default(''),
    sign: z.string().default(''),
    level_info: z
      .object({ current_level: numish })
      .passthrough()
      .optional(),
    fans: numish,
    follower: numish,
    attention: numish,
    following: numish,
    archive_count: numish,
    video_count: numish,
    archive: z
      .object({ count: numish })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** 取第一个「真实存在」的数字；全都没有 → null（未知） */
function pickNumber(...values: (number | null | undefined)[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

const spaceUpstat = z
  .object({
    archive: z.object({ view: z.number().int().nonnegative().optional() }).passthrough().optional(),
    article: z.object({ view: z.number().int().nonnegative().optional() }).passthrough().optional(),
    likes: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * V0.1.3：新增两个「匿名可用」的真实补充来源。
 * 实机验证（tests/fixtures/real/）：wbi/acc/info 在匿名 + 风控下返回 -352/-401，
 * 而 relation/stat 与 navnum 依然 code=0，能拿到真实粉丝 / 关注 / 投稿数。
 */

/** /x/relation/stat —— 真实字段：data.follower（粉丝）、data.following（关注） */
export function normalizeRelationStat(
  raw: unknown,
): { followers: number | null; following: number | null } {
  const NONE = { followers: null as number | null, following: null as number | null };
  if (!raw || typeof raw !== 'object') return NONE;
  const code = biliCode(raw);
  if (code !== null && code !== 0) return NONE;
  const d = (raw as { data?: Record<string, unknown> }).data;
  if (!d || typeof d !== 'object') return NONE;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return { followers: num(d.follower ?? d.fans), following: num(d.following ?? d.attention) };
}

/** /x/space/navnum —— 真实字段：data.video（投稿数）、data.article */
export function normalizeNavnum(raw: unknown): { videoCount: number | null } {
  const NONE = { videoCount: null as number | null };
  if (!raw || typeof raw !== 'object') return NONE;
  const code = biliCode(raw);
  if (code !== null && code !== 0) return NONE;
  const d = (raw as { data?: Record<string, unknown> }).data;
  if (!d || typeof d !== 'object') return NONE;
  const v = d.video;
  return { videoCount: typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null };
}

export function normalizeCreator(raw: unknown, opts?: { source?: Source; now?: string }): Creator {
  const source: Source = opts?.source ?? 'bili-api';
  const now = opts?.now ?? nowIso();

  let card: z.infer<typeof cardDataSchema> | null = null;
  let upstat: z.infer<typeof spaceUpstat> | null = null;
  let apiCode = 0;
  let apiMessage: string | undefined;

  if (raw && typeof raw === 'object') {
    const r = raw as BiliApiResp;
    apiCode = typeof r.code === 'number' ? r.code : 0;
    apiMessage = r.message;
    if (r.data && typeof r.data === 'object') {
      const d = r.data as Record<string, unknown>;
      // 兼容三种真实形态：
      //   1) acc/info：data 本身就是资料卡
      //   2) /x/web-interface/card：资料在 data.card，投稿数在 data.archive_count
      //   3) 少数响应还会包一层 card + upstat
      const cardObj = d.card && typeof d.card === 'object' ? (d.card as Record<string, unknown>) : {};
      const merged = { ...d, ...cardObj };
      const cardParsed = cardDataSchema.safeParse(merged);
      if (cardParsed.success) card = cardParsed.data;
      const statParsed = spaceUpstat.safeParse(d.upstat ?? d);
      if (statParsed.success) upstat = statParsed.data;
    }
  }

  if (!card) {
    throw new Error(
      `normalizeCreator: cannot extract creator data (api code=${apiCode} message=${apiMessage ?? 'n/a'})`,
    );
  }

  const avatar = isValidUrl(card.face) ? card.face : undefined;
  const candidate = {
    id: newId('cr'),
    uid: card.mid,
    name: card.name || `uid_${card.mid}`,
    avatar,
    sign: card.sign ?? '',
    level: typeof card.level_info?.current_level === 'number' ? card.level_info.current_level : null,
    followers: pickNumber(card.fans, card.follower),
    following: pickNumber(card.attention, card.following),
    videoCount: pickNumber(card.archive_count, card.video_count, card.archive?.count),
    spaceUrl: `https://space.bilibili.com/${card.mid}/`,
    lastCollectedAt: now,
    createdAt: now,
    updatedAt: now,
    source,
  };
  const parsed = creatorSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`normalizeCreator: zod failed: ${parsed.error.message}`);
  }
  // 真实实现里 totalViews 等应通过单独 upstat 接口拿到；此处为兼容旧数据
  void upstat;
  return parsed.data;
}

export interface CreatorTotals {
  /** null = 未采集到（接口被风控 / 不可用），不等于 0 */
  totalViews: number | null;
  totalLikes: number | null;
  totalArticles: number | null;
  /** 本次是否真的拿到了 upstat 数据 */
  available: boolean;
}

const TOTALS_UNAVAILABLE: CreatorTotals = {
  totalViews: null,
  totalLikes: null,
  totalArticles: null,
  available: false,
};

/**
 * 单独解析 upstat 响应为 totals。
 * V0.1.2（P1-6）：拿不到数据时返回 null + available=false，
 * 不允许用 0 伪装成「采集到 0 播放」——那会让趋势图和 AI 分析得出错误结论。
 */
export function normalizeCreatorTotals(raw: unknown): CreatorTotals {
  if (raw === null || raw === undefined) return TOTALS_UNAVAILABLE;
  // HTTP 200 但 code != 0（如 -352 风控）视为不可用
  const code = biliCode(raw);
  if (code !== null && code !== 0) return TOTALS_UNAVAILABLE;

  const body = raw as { data?: unknown };
  const statParsed = spaceUpstat.safeParse(body.data ?? raw);
  if (!statParsed.success) return TOTALS_UNAVAILABLE;
  const s = statParsed.data;
  const archiveView = s.archive?.view ?? null;
  const articleView = s.article?.view ?? null;
  const likes = s.likes ?? null;
  // 真实匿名响应（tests/fixtures/real/upstat.json）是 `code:0, data:{}`：
  // 没有 archive.view 也没有 likes —— 此时必须判定为「不可用」，不能算成 0 播放。
  if (archiveView === null && likes === null) return TOTALS_UNAVAILABLE;
  return {
    totalViews: (archiveView ?? 0) + (articleView ?? 0),
    totalLikes: likes,
    totalArticles: null,
    available: true,
  };
}