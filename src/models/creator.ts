import { z } from 'zod';
import { baseFields, isoString, nonEmpty, urlLike } from './common';

export const creatorSchema = z.object({
  id: nonEmpty,
  uid: z.number().int().nonnegative(),
  name: nonEmpty,
  avatar: urlLike.optional(),
  sign: z.string().default(''),
  level: z.number().int().min(0).max(7).default(0),
  followers: z.number().int().nonnegative().default(0),
  following: z.number().int().nonnegative().default(0),
  videoCount: z.number().int().nonnegative().default(0),
  spaceUrl: urlLike,
  lastCollectedAt: isoString.optional(),
  ...baseFields.shape,
});

export type Creator = z.infer<typeof creatorSchema>;

export const creatorSnapshotSchema = z.object({
  id: nonEmpty,
  creatorId: nonEmpty,
  timestamp: isoString,
  followers: z.number().int().nonnegative(),
  following: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  // V0.1.2（P1-6）：null = 本次没采集到（upstat 被风控），绝不能写成 0 假装「采集到 0」
  totalViews: z.number().int().nonnegative().nullable().default(null),
  totalLikes: z.number().int().nonnegative().nullable().default(null),
  totalComments: z.number().int().nonnegative().nullable().default(null),
  totalFavorites: z.number().int().nonnegative().nullable().default(null),
  source: z.enum(['bili-api', 'bili-web', 'manual']),
});

export type CreatorSnapshot = z.infer<typeof creatorSnapshotSchema>;