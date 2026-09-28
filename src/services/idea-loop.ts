/**
 * 灵感闭环（V0.2 · P1 · Group D）。
 *
 * 三段式闭环：热点（HotTopic）→ 灵感（Idea）→ 实验（Experiment）。
 * 本模块只负责「建立可追踪的连接」与状态流转，不做内容生成、不做结论推断。
 *
 * 设计要点：
 *  - 每一跳都保留来源引用（sourceRef / ideaId），保证「这个想法/实验从哪来」可回溯。
 *  - 状态流转是显式的白名单，不允许随意跳转（避免看板变成无序标签墙）。
 */

import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { ideaSchema, experimentSchema, type Idea, type IdeaStatus, type Experiment, type HotTopic } from '@models/idea';
import { ideaRepo, experimentRepo } from '@repositories/index';

/** 灵感状态机：允许的下一步（显式白名单） */
export const IDEA_TRANSITIONS: Record<IdeaStatus, IdeaStatus[]> = {
  idea: ['researching', 'reviewing', 'discarded', 'archived'],
  researching: ['reviewing', 'ready', 'discarded', 'archived'],
  reviewing: ['ready', 'researching', 'discarded', 'archived'],
  ready: ['producing', 'reviewing', 'discarded', 'archived'],
  producing: ['published', 'ready', 'discarded', 'archived'],
  published: ['verified', 'producing', 'archived'],
  verified: ['archived', 'producing'],
  discarded: ['archived', 'idea'],
  archived: [],
};

export function canTransition(from: IdeaStatus, to: IdeaStatus): boolean {
  return IDEA_TRANSITIONS[from].includes(to);
}

/** 把一条热搜/热榜条目转成灵感（记录来源引用） */
export async function hotTopicToIdea(
  topic: HotTopic,
  opts: { title?: string; tags?: string[]; note?: string } = {},
): Promise<Idea> {
  const now = nowIso();
  const candidate = ideaSchema.parse({
    id: newId('id'),
    title: (opts.title ?? topic.title).slice(0, 200),
    content: '',
    tags: (opts.tags ?? topic.relatedTags).slice(0, 20),
    source: 'hot',
    sourceRef: { kind: 'hot-topic', refId: topic.id, refLabel: topic.title.slice(0, 200) },
    status: 'idea',
    notes: opts.note ?? '',
    createdAt: now,
    updatedAt: now,
  });
  await ideaRepo.add(candidate);
  return candidate;
}

/** 由灵感创建实验（关联 ideaId，形成闭环） */
export async function ideaToExperiment(
  idea: Idea,
  opts: { hypothesis?: string; targetAccount?: string; expectedResult?: string } = {},
): Promise<Experiment> {
  const now = nowIso();
  const candidate = experimentSchema.parse({
    id: newId('ex'),
    hypothesis: (opts.hypothesis ?? idea.title).slice(0, 2000),
    targetAccount: opts.targetAccount ?? '',
    topic: (idea.tags[0] ?? '').slice(0, 100),
    ideaId: idea.id,
    videoIds: [],
    expectedResult: opts.expectedResult ?? '',
    actualResult: '',
    conclusion: '',
    status: 'planned',
    createdAt: now,
    updatedAt: now,
  });
  await experimentRepo.add(candidate);
  return candidate;
}

/** 流转灵感状态（校验白名单，非法跳转抛出明确错误） */
export async function transitionIdea(idea: Idea, to: IdeaStatus): Promise<void> {
  if (!canTransition(idea.status, to)) {
    throw new Error(`invalid idea transition: ${idea.status} → ${to}`);
  }
  await ideaRepo.updateStatus(idea.id, to);
}
