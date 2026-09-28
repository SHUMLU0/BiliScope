import { z } from 'zod';
import { baseFields, isoString, nonEmpty, urlLike } from './common';

export const creatorSchema = z.object({
  id: nonEmpty,
  uid: z.number().int().nonnegative(),
  name: nonEmpty,
  avatar: urlLike.optional(),
  sign: z.string().default(''),
  // V0.1.3（P0-2）：null = 接口没给 / 被风控，绝不能填 0 伪装成「真实是 0」
  level: z.number().int().min(0).max(7).nullable().default(null),
  followers: z.number().int().nonnegative().nullable().default(null),
  following: z.number().int().nonnegative().nullable().default(null),
  videoCount: z.number().int().nonnegative().nullable().default(null),
  spaceUrl: urlLike,
  lastCollectedAt: isoString.optional(),
  ...baseFields.shape,
});

export type Creator = z.infer<typeof creatorSchema>;

export const creatorSnapshotSchema = z.object({
  id: nonEmpty,
  creatorId: nonEmpty,
  timestamp: isoString,
  // V0.1.3（P0-2）：这三个字段同样允许 null，与 Creator 保持一致
  followers: z.number().int().nonnegative().nullable(),
  following: z.number().int().nonnegative().nullable(),
  videoCount: z.number().int().nonnegative().nullable(),
  // V0.1.2（P1-6）：null = 本次没采集到（upstat 被风控），绝不能写成 0 假装「采集到 0」
  totalViews: z.number().int().nonnegative().nullable().default(null),
  totalLikes: z.number().int().nonnegative().nullable().default(null),
  totalComments: z.number().int().nonnegative().nullable().default(null),
  totalFavorites: z.number().int().nonnegative().nullable().default(null),
  source: z.enum(['bili-api', 'bili-web', 'manual']),
});

export type CreatorSnapshot = z.infer<typeof creatorSnapshotSchema>;