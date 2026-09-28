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

/** 兼容多种 duration 表示：number、numeric string、"MM:SS"、"HH:MM:SS" */
export function parseDurationToSeconds(raw: unknown): number {
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
    // V0.1.1：兼容 number/string duration
    const durationSec = parseDurationToSeconds((item as { duration?: unknown }).duration ?? v.duration);
    const candidate = {
      id: newId('vd'),
      bvid: v.bvid,
      aid: v.aid,
      creatorId: opts.creatorId,
      title: v.title,
      description: v.desc,
      cover,
      pubTime: secondsToIso(v.pubdate || Math.floor(Date.now() / 1000)),
      duration: durationSec,
      category: v.tname,
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

const statRespSchema = z
  .object({
    code: z.number().int().default(0),
    message: z.string().default(''),
    data: z
      .object({
        bvid: z.string(),
        aid: z.number().int(),
        view: z.number().int().nonnegative().default(0),
        like: z.number().int().nonnegative().default(0),
        coin: z.number().int().nonnegative().default(0),
        favorite: z.number().int().nonnegative().default(0),
        share: z.number().int().nonnegative().default(0),
        reply: z.number().int().nonnegative().default(0),
        danmaku: z.number().int().nonnegative().default(0),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface VideoStat {
  bvid: string;
  aid: number;
  views: number;
  likes: number;
  coins: number;
  favorites: number;
  shares: number;
  comments: number;
  danmaku: number;
}

export function normalizeVideoStat(raw: unknown): VideoStat | null {
  const parsed = statRespSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data) return null;
  const d = parsed.data.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    views: d.view,
    likes: d.like,
    coins: d.coin,
    favorites: d.favorite,
    shares: d.share,
    comments: d.reply,
    danmaku: d.danmaku,
  };
}