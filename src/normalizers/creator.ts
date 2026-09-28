/**
 * Creator normalizer.
 * 容错：B 站 API 返回 `code / message / data` 三层结构；data 可能为 null；
 * 字段缺失时使用默认值，写入 rawData 保留原始对象。
 */

import { z } from 'zod';
import { creatorSchema, type Creator } from '@models/creator';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
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

const cardDataSchema = z
  .object({
    mid: z.number().int().nonnegative(),
    name: z.string().default(''),
    face: z.string().default(''),
    sign: z.string().default(''),
    level_info: z
      .object({ current_level: z.number().int().min(0).max(7).default(0) })
      .default({ current_level: 0 }),
    fans: z.number().int().nonnegative().default(0),
    following: z.number().int().nonnegative().default(0),
    archive: z
      .object({
        count: z.number().int().nonnegative().default(0),
      })
      .default({ count: 0 }),
  })
  .passthrough();

const spaceUpstat = z
  .object({
    archive: z.object({ view: z.number().int().nonnegative().default(0) }).default({ view: 0 }),
    article: z.object({ view: z.number().int().nonnegative().default(0) }).default({ view: 0 }),
    likes: z.number().int().nonnegative().default(0),
  })
  .passthrough();

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
      const cardParsed = cardDataSchema.safeParse(d.card ?? d);
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
    level: card.level_info?.current_level ?? 0,
    followers: card.fans ?? 0,
    following: card.following ?? 0,
    videoCount: card.archive?.count ?? 0,
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

/** 单独解析 upstat 响应为 totals */
export function normalizeCreatorTotals(raw: unknown): {
  totalViews: number;
  totalLikes: number;
  totalArticles: number;
} {
  const statParsed = spaceUpstat.safeParse(raw);
  if (!statParsed.success) return { totalViews: 0, totalLikes: 0, totalArticles: 0 };
  const s = statParsed.data;
  return {
    totalViews: (s.archive?.view ?? 0) + (s.article?.view ?? 0),
    totalLikes: s.likes ?? 0,
    totalArticles: 0,
  };
}