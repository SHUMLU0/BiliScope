import { z } from 'zod';
import { isoString, nonEmpty, urlLike } from './common';

export const ideaStatusEnum = z.enum([
  'idea',
  'researching',
  'ready',
  'producing',
  'published',
  'verified',
  'discarded',
]);

export type IdeaStatus = z.infer<typeof ideaStatusEnum>;

const sourceEnum = z.enum(['manual', 'comment', 'hot', 'import']);

export const ideaSchema = z.object({
  id: nonEmpty,
  title: nonEmpty.max(200),
  content: z.string().max(20_000).default(''),
  tags: z.array(z.string().max(40)).max(20).default([]),
  source: sourceEnum.default('manual'),
  status: ideaStatusEnum.default('idea'),
  notes: z.string().max(5000).default(''),
  createdAt: isoString,
  updatedAt: isoString,
});

export type Idea = z.infer<typeof ideaSchema>;

export const topicSchema = z.object({
  id: nonEmpty,
  name: nonEmpty.max(100),
  tags: z.array(z.string().max(40)).max(20).default([]),
  source: z.string().max(100).default(''),
  competitionLevel: z.enum(['unknown', 'low', 'medium', 'high']).default('unknown'),
  notes: z.string().max(5000).default(''),
  createdAt: isoString,
  updatedAt: isoString,
});

export type Topic = z.infer<typeof topicSchema>;

export const experimentStatusEnum = z.enum(['planned', 'running', 'completed', 'aborted']);
export type ExperimentStatus = z.infer<typeof experimentStatusEnum>;

export const experimentSchema = z.object({
  id: nonEmpty,
  hypothesis: nonEmpty.max(2000),
  targetAccount: z.string().max(100).default(''),
  topic: z.string().max(100).default(''),
  videoIds: z.array(z.string()).max(50).default([]),
  expectedResult: z.string().max(2000).default(''),
  actualResult: z.string().max(2000).default(''),
  conclusion: z.string().max(2000).default(''),
  status: experimentStatusEnum.default('planned'),
  createdAt: isoString,
  updatedAt: isoString,
});

export type Experiment = z.infer<typeof experimentSchema>;

export const hotTopicSchema = z.object({
  id: nonEmpty,
  title: nonEmpty.max(200),
  source: z.enum(['bili-hot', 'bili-search', 'bili-rank']),
  url: urlLike.optional(),
  rank: z.number().int().nonnegative(),
  timestamp: isoString,
  category: z.string().max(100).default(''),
  relatedTags: z.array(z.string().max(40)).max(20).default([]),
});

export type HotTopic = z.infer<typeof hotTopicSchema>;