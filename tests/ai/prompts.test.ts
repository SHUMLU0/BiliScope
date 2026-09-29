import { describe, expect, it } from 'vitest';
import {
  buildCreatorAnalyzePrompt,
  buildVideoAnalyzePrompt,
  buildCommentAnalyzePrompt,
  buildRepairPrompt,
  COMMENT_SCHEMA_TEXT,
  GENERAL_SCHEMA_TEXT,
} from '@ai/prompts';
import type { Creator } from '@models/creator';
import type { Video } from '@models/video';
import type { SampleComment } from '@services/comment-prep';

const creator: Creator = {
  id: 'cr1',
  uid: 1,
  name: 'foo',
  avatar: 'https://example.com/f.jpg',
  sign: 'hi',
  level: 3,
  followers: 1000,
  following: 10,
  videoCount: 5,
  spaceUrl: 'https://space.bilibili.com/1/',
  lastCollectedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: 'bili-api',
};

const video: Video = {
  id: 'v1',
  bvid: 'BV1xxxxxxxxxx',
  aid: 1,
  creatorId: 'cr1',
  title: 't',
  description: '',
  cover: undefined,
  pubTime: '2026-01-01T00:00:00.000Z',
  duration: 60,
  category: '',
  tags: ['a'],
  url: 'https://www.bilibili.com/video/BV1xxxxxxxxxx',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: 'bili-api',
};

/** V3.1.0 · P0-AI 隐私化：prompt 只消费 prepare 层产出的匿名样本（零身份字段） */
const sample: SampleComment[] = [
  {
    ref: 'C001',
    content: '内容',
    likes: 0,
    replyCount: 0,
    replyLevel: 1,
    selectionReason: '高赞样本',
    rankInSample: 1,
  },
];

describe('prompts · Creator / Video', () => {
  it('buildCreatorAnalyzePrompt declares the general schema (facts/explanations/uncertainty)', () => {
    const { system, user } = buildCreatorAnalyzePrompt({ creator, recentVideos: [video], recentSnapshots: [] });
    expect(system).toContain('facts');
    expect(system).toContain('explanations');
    expect(system).toContain('uncertainty');
    expect(user).toContain('foo');
  });

  // V0.1.1 修复（独立验收反馈 · 字段错误）：
  // 原 buildCreatorAnalyzePrompt 误把 v.duration 当成 views 喂给 AI。
  it('buildCreatorAnalyzePrompt: recentVideos uses correct duration field, not views', () => {
    const { user } = buildCreatorAnalyzePrompt({ creator, recentVideos: [video], recentSnapshots: [] });
    const parsed = JSON.parse(user) as {
      recentVideos: Array<Record<string, unknown>>;
      snapshots: unknown[];
    };
    expect(parsed.recentVideos).toHaveLength(1);
    const v = parsed.recentVideos[0]!;
    expect(v).toHaveProperty('duration', video.duration);
    expect(v).not.toHaveProperty('views');
    expect(user).not.toMatch(/"views":\s*\d+/);
  });

  it('buildVideoAnalyzePrompt excludes prediction language', () => {
    const { system } = buildVideoAnalyzePrompt({ video, comments: [] });
    expect(system).not.toMatch(/爆款概率/);
    expect(system).not.toMatch(/一定爆/);
  });
});

describe('prompts · Comment（V3.0 单 schema + V3.1 匿名引用）', () => {
  it('declares EXACTLY ONE schema — no contradictory second schema', () => {
    const { system } = buildCommentAnalyzePrompt({ sample });
    // 新 schema 的全部顶层字段必须出现
    for (const field of [
      'summary',
      'facts',
      'findings',
      'themes',
      'support',
      'opposition',
      'needs',
      'questions',
      'uncertainty',
      'nextResearch',
    ]) {
      expect(system).toContain(field);
    }
    // 旧的、互相冲突的字段不得再出现
    expect(system).not.toContain('"explanations"');
    expect(system).not.toContain('"evidence": {');
    // 不得再声明两套 schema（"必须分三段输出" 是旧矛盾来源）
    expect(system).not.toMatch(/必须分三段输出/);
  });

  it('states the schema only once (no duplicated schema blocks)', () => {
    const { system } = buildCommentAnalyzePrompt({ sample });
    const occurrences = system.split('"nextResearch"').length - 1;
    expect(occurrences).toBe(1);
  });

  it('requires anonymous ref citations (refs) for support / opposition', () => {
    const { system } = buildCommentAnalyzePrompt({ sample });
    expect(system).toMatch(/refs/);
    expect(system).toMatch(/support/);
    expect(system).toMatch(/opposition/);
  });

  it('forbids the exact phrasing the user listed', () => {
    const { system } = buildCommentAnalyzePrompt({ sample });
    // 第九节明列的禁用语必须逐条出现在 prompt 中
    expect(system).toMatch(/大多数用户都/);
    expect(system).toMatch(/用户普遍/);
    expect(system).toMatch(/观众一定/);
    expect(system).toMatch(/这个视频导致/);
    expect(system).toMatch(/词频/);
    expect(system).toMatch(/因果/);
  });

  it('requires uncertainty to state sample size / cleaning / bias / completeness', () => {
    const { system } = buildCommentAnalyzePrompt({ sample });
    expect(system).toMatch(/样本量/);
    expect(system).toMatch(/抽样偏差/);
    expect(system).toMatch(/数据完整性/);
  });

  it('includes facts block separately and requires anonymous ref citations', () => {
    const { system, user } = buildCommentAnalyzePrompt({
      sample,
      factsJson: JSON.stringify({ totalCollected: 1, stats: { total: 1 }, keywords: [], topComments: [], droppedNoisy: 0 }),
    });
    expect(system).toMatch(/refs/);
    // 「facts 段不得编造数字」必须以某种形式出现
    expect(system).toMatch(/禁止编造数字|不得编造数字/);
    const parsed = JSON.parse(user) as { facts: unknown; sample: Array<{ ref: string }> };
    expect(parsed.facts).toBeTruthy();
    expect(parsed.sample[0]!.ref).toBe('C001');
  });

  it('works without factsJson (backward compatible)', () => {
    const { user } = buildCommentAnalyzePrompt({ sample: [] });
    const parsed = JSON.parse(user) as { facts?: unknown };
    expect(parsed.facts).toBeUndefined();
  });

  it('does not crash on malformed factsJson', () => {
    const { user } = buildCommentAnalyzePrompt({
      sample,
      factsJson: '{broken',
    });
    const parsed = JSON.parse(user) as { facts?: unknown; sample: unknown[] };
    expect(parsed.facts).toBeUndefined();
    expect(parsed.sample).toHaveLength(1);
  });
});

describe('prompts · 自动修复（V3.0 · 第七节）', () => {
  it('repair prompt forbids re-analysis and new facts', () => {
    const { system, user } = buildRepairPrompt({
      domain: 'comment',
      previousRaw: '{"summary":"x"}',
      issues: ['support: Required'],
    });
    expect(system).toMatch(/严禁重新分析数据/);
    expect(system).toMatch(/严禁添加任何新的/);
    expect(user).toContain('把下面已有结果修正为指定 schema，不添加新的事实。');
    expect(user).toContain('support: Required');
  });

  it('repair prompt reuses the SAME schema text as the normal prompt', () => {
    const { system } = buildRepairPrompt({ domain: 'comment', previousRaw: '{}' });
    expect(system).toContain(COMMENT_SCHEMA_TEXT);
  });

  it('repair prompt uses the general schema for creator domain', () => {
    const { system } = buildRepairPrompt({ domain: 'creator', previousRaw: '{}' });
    expect(system).toContain(GENERAL_SCHEMA_TEXT);
    expect(system).not.toContain(COMMENT_SCHEMA_TEXT);
  });

  it('truncates overly long previous results', () => {
    const { user } = buildRepairPrompt({ domain: 'comment', previousRaw: 'x'.repeat(20_000) });
    expect(user.length).toBeLessThan(15_000);
  });
});
