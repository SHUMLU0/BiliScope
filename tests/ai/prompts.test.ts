import { describe, expect, it } from 'vitest';
import { buildCreatorAnalyzePrompt, buildVideoAnalyzePrompt, buildCommentAnalyzePrompt } from '@ai/prompts';
import type { Creator } from '@models/creator';
import type { Video } from '@models/video';
import type { Comment } from '@models/comment';

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

const comment: Comment = {
  id: 'c1',
  videoId: 'v1',
  parentId: 0,
  rpid: 1,
  memberId: 'a'.repeat(32),
  uname: 'u',
  content: 'm',
  like: 0,
  replyCount: 0,
  ctime: 1700000000,
  level: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('prompts', () => {
  it('buildCreatorAnalyzePrompt requires facts/explanations/uncertainty', () => {
    const { system, user } = buildCreatorAnalyzePrompt({ creator, recentVideos: [video], recentSnapshots: [] });
    expect(system).toMatch(/facts/);
    expect(system).toMatch(/explanations/);
    expect(system).toMatch(/uncertainty/);
    expect(user).toContain('foo');
  });

  // V0.1.1 修复（独立验收反馈 · 字段错误）：
  // 原 buildCreatorAnalyzePrompt 误把 v.duration 当成 views 喂给 AI。
  // 修复后 recentVideos 段只写 duration；views 数据由 snapshots 段承担。
  it('buildCreatorAnalyzePrompt: recentVideos uses correct duration field, not views', () => {
    const { user } = buildCreatorAnalyzePrompt({ creator, recentVideos: [video], recentSnapshots: [] });
    const parsed = JSON.parse(user) as {
      recentVideos: Array<Record<string, unknown>>;
      snapshots: unknown[];
    };
    expect(parsed.recentVideos).toHaveLength(1);
    const v = parsed.recentVideos[0]!;
    // 真实字段 = duration，不再误传 views（views 来自 snapshots）
    expect(v).toHaveProperty('duration', video.duration);
    expect(v).not.toHaveProperty('views');
    // 模板里也不应有 "views: v.duration" 这类误导性片段
    expect(user).not.toMatch(/"views":\s*\d+/);
  });

  it('buildVideoAnalyzePrompt excludes prediction language', () => {
    const { system } = buildVideoAnalyzePrompt({ video, comments: [] });
    expect(system).not.toMatch(/爆款概率/);
    expect(system).not.toMatch(/一定爆/);
  });

  it('buildCommentAnalyzePrompt anti wordcloud hallucination', () => {
    const { system } = buildCommentAnalyzePrompt({ videoId: 'v1', comments: [comment] });
    expect(system).toMatch(/主题|痛点|情绪/);
  });
});