import { z } from 'zod';
import { isoString, nonEmpty } from './common';

export const commentSchema = z.object({
  id: nonEmpty,
  videoId: nonEmpty,
  parentId: z.number().int().nonnegative().default(0),
  rpid: z.number().int().nonnegative(),
  memberId: z.string().regex(/^[a-f0-9]{32}$/i, 'invalid mid hash'),
  uname: z.string().max(64),
  content: z.string().max(5000),
  like: z.number().int().nonnegative().default(0),
  replyCount: z.number().int().nonnegative().default(0),
  ctime: z.number().int().nonnegative(),
  level: z.number().int().min(0).max(7).default(0),
  rawData: z.unknown().optional(),
  createdAt: isoString,
});

export type Comment = z.infer<typeof commentSchema>;

export const commentAnalysisSchema = z.object({
  id: nonEmpty,
  videoId: nonEmpty,
  createdAt: isoString,
  model: z.string().min(1),
  themeResult: z.array(z.string()).default([]),
  sentimentResult: z
    .object({
      positive: z.number().int().nonnegative().default(0),
      neutral: z.number().int().nonnegative().default(0),
      negative: z.number().int().nonnegative().default(0),
    })
    .default({ positive: 0, neutral: 0, negative: 0 }),
  questionResult: z.array(z.string()).default([]),
  supportResult: z.array(z.string()).default([]),
  oppositionResult: z.array(z.string()).default([]),
  userNeedResult: z.array(z.string()).default([]),
  rawResponse: z.unknown().optional(),
});

export type CommentAnalysis = z.infer<typeof commentAnalysisSchema>;