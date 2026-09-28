/**
 * Video normalizer.
 * - listVideos 返回结构里 `vlist` 数组（archive API） 或 `data.list.vlist`
 * - 单视频详情需要 stat 接口合并数据
 */

import { z } from 'zod';
import { videoSchema, type Video } from '@models/video';
import { newId } from '@utils/id';
import { nowIso, secondsToIso } from '@utils/time';
import type { Source } from '@models/common';

const rawVideoSchema = z
  .object({
    bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
    aid: z.number().int().nonnegative(),
    title: z.string().default(''),
    desc: z.string().default(''),
    pic: z.string().default(''),
    pubdate: z.number().int().nonnegative().default(0),
    duration: z.number().int().nonnegative().default(0),
    tname: z.string().default(''),
    tag: z.string().default(''),
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
    const candidate = {
      id: newId('vd'),
      bvid: v.bvid,
      aid: v.aid,
      creatorId: opts.creatorId,
      title: v.title,
      description: v.desc,
      cover,
      pubTime: secondsToIso(v.pubdate || Math.floor(Date.now() / 1000)),
      duration: v.duration,
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