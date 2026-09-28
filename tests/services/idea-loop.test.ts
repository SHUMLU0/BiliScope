import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '@db/database';
import { hotTopicToIdea, ideaToExperiment, canTransition, transitionIdea, IDEA_TRANSITIONS } from '@services/idea-loop';
import { ideaRepo, experimentRepo } from '@repositories/index';
import { hotTopicSchema, type Idea } from '@models/idea';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';

beforeEach(async () => {
  await clearAll();
});

const topic = hotTopicSchema.parse({
  id: 'ht_1',
  title: 'AI 编程助手评测',
  source: 'bili-hot',
  rank: 1,
  timestamp: nowIso(),
  category: '科技',
  relatedTags: ['ai', 'cursor'],
});

describe('idea-loop (V0.2 · Group D)', () => {
  it('hotTopicToIdea records sourceRef for traceability', async () => {
    const idea = await hotTopicToIdea(topic);
    expect(idea.source).toBe('hot');
    expect(idea.sourceRef).toEqual({ kind: 'hot-topic', refId: 'ht_1', refLabel: 'AI 编程助手评测' });
    expect(idea.status).toBe('idea');
    const byRef = await ideaRepo.listBySourceRef('hot-topic', 'ht_1');
    expect(byRef).toHaveLength(1);
    expect(byRef[0]!.id).toBe(idea.id);
  });

  it('ideaToExperiment links ideaId (closed loop)', async () => {
    const idea = await hotTopicToIdea(topic, { tags: ['ai'] });
    const exp = await ideaToExperiment(idea, { targetAccount: '我的号', expectedResult: '播放翻倍' });
    expect(exp.ideaId).toBe(idea.id);
    expect(exp.status).toBe('planned');
    expect(exp.hypothesis).toBe('AI 编程助手评测');
    const byIdea = await experimentRepo.listByIdea(idea.id);
    expect(byIdea).toHaveLength(1);
  });

  it('canTransition whitelist works; invalid throws', async () => {
    expect(canTransition('idea', 'researching')).toBe(true);
    expect(canTransition('idea', 'published')).toBe(false); // 不能一步到位
    expect(canTransition('archived', 'idea')).toBe(false); // 归档是终态

    const idea: Idea = {
      id: newId('id'),
      title: 'x',
      content: '',
      tags: [],
      source: 'manual',
      status: 'idea',
      notes: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await ideaRepo.add(idea);
    await expect(transitionIdea(idea, 'published')).rejects.toThrow(/invalid idea transition/);
    await transitionIdea(idea, 'researching');
    expect((await ideaRepo.get(idea.id))!.status).toBe('researching');
  });

  it('all statuses have a transition entry', () => {
    for (const key of Object.keys(IDEA_TRANSITIONS)) {
      expect(Array.isArray(IDEA_TRANSITIONS[key as keyof typeof IDEA_TRANSITIONS])).toBe(true);
    }
    expect(Object.keys(IDEA_TRANSITIONS)).toHaveLength(9);
  });
});
