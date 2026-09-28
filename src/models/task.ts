import { z } from 'zod';
import { isoString, nonEmpty } from './common';

export const collectionTaskTypeEnum = z.enum([
  'creator',
  'creator-videos',
  'video-snapshot',
  'video-detail',
  'video-comments',
  'hot-topic',
  'search',
  'my-data',
  'ai-analysis',
]);

export type CollectionTaskType = z.infer<typeof collectionTaskTypeEnum>;

export const collectionTaskStatusEnum = z.enum([
  'pending',
  'running',
  'success',
  'partial',
  'failed',
  'cancelled',
]);

export type CollectionTaskStatus = z.infer<typeof collectionTaskStatusEnum>;

export const collectionTaskSchema = z.object({
  id: nonEmpty,
  type: collectionTaskTypeEnum,
  targetId: z.string().max(200).default(''),
  status: collectionTaskStatusEnum.default('pending'),
  createdAt: isoString,
  startedAt: isoString.optional(),
  finishedAt: isoString.optional(),
  retryCount: z.number().int().nonnegative().default(0),
  errorMessage: z.string().max(2000).optional(),
  progress: z.number().min(0).max(1).default(0),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type CollectionTask = z.infer<typeof collectionTaskSchema>;

export const aiAnalysisSchema = z.object({
  id: nonEmpty,
  type: z.enum(['creator', 'comment', 'video', 'idea']),
  targetId: nonEmpty,
  provider: z.enum(['openai-compatible', 'deepseek', 'gemini', 'custom']),
  model: z.string().min(1),
  systemPrompt: z.string().max(8000),
  userPrompt: z.string().max(8000),
  rawResponse: z.unknown().optional(),
  parsedResult: z.unknown().optional(),
  tokenUsage: z
    .object({
      prompt: z.number().int().nonnegative().default(0),
      completion: z.number().int().nonnegative().default(0),
      total: z.number().int().nonnegative().default(0),
    })
    .optional(),
  durationMs: z.number().int().nonnegative().default(0),
  createdAt: isoString,
});

export type AIAnalysis = z.infer<typeof aiAnalysisSchema>;