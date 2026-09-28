import { z } from 'zod';
import { baseFields, isoString, nonEmpty, urlLike } from './common';

export const videoSchema = z.object({
  id: nonEmpty,
  bvid: nonEmpty.regex(/^BV[0-9A-Za-z]{10}$/, 'invalid bvid'),
  aid: z.number().int().nonnegative(),
  creatorId: nonEmpty,
  title: z.string().min(1).max(500),
  description: z.string().max(5000).default(''),
  cover: urlLike.optional(),
  pubTime: isoString,
  duration: z.number().int().nonnegative(),
  category: z.string().default(''),
  tags: z.array(z.string().max(50)).max(50).default([]),
  url: urlLike,
  // V0.1.2（P0-4）：全站搜索链路下的 UP 与播放信息。
  // 这三个字段是「可选」而非默认 0 —— 缺失表示未知，UI 显示 –，不允许伪装成 0。
  authorName: z.string().max(100).optional(),
  authorMid: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  ...baseFields.shape,
});

export type Video = z.infer<typeof videoSchema>;

export const videoSnapshotSchema = z.object({
  id: nonEmpty,
  videoId: nonEmpty,
  timestamp: isoString,
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  coins: z.number().int().nonnegative(),
  favorites: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  danmaku: z.number().int().nonnegative(),
  source: z.enum(['bili-api', 'bili-web', 'manual']),
});

export type VideoSnapshot = z.infer<typeof videoSnapshotSchema>;