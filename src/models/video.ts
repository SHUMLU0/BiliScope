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
  // V0.1.3（P0-3）：投稿列表真实字段是 created / length；拿不到时是 null，
  // 不允许退回 Date.now() 或 0 —— 那会让「全部今天 / 全部 0s」看起来像真实数据。
  pubTime: isoString.nullable(),
  duration: z.number().int().nonnegative().nullable(),
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
  // V0.1.3（P0-6）：投稿列表只给得出 play（播放），其余指标必须保持 null，
  // 不允许用 0 填充成"采集到 0 点赞"。
  views: z.number().int().nonnegative().nullable().default(null),
  likes: z.number().int().nonnegative().nullable().default(null),
  coins: z.number().int().nonnegative().nullable().default(null),
  favorites: z.number().int().nonnegative().nullable().default(null),
  shares: z.number().int().nonnegative().nullable().default(null),
  comments: z.number().int().nonnegative().nullable().default(null),
  danmaku: z.number().int().nonnegative().nullable().default(null),
  source: z.enum(['bili-api', 'bili-web', 'manual']),
});

export type VideoSnapshot = z.infer<typeof videoSnapshotSchema>;