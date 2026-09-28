import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '@db/database';
import { prepareCommentAnalysis, serializeCommentFacts } from '@services/comment-prep';
import { buildCommentAnalyzePrompt } from '@ai/prompts';
import type { Comment } from '@models/comment';

const iso = new Date(0).toISOString();

const cm = (over: Partial<Comment> & { rpidStr: string; content: string }): Comment => ({
  id: `c${over.rpidStr}`,
  videoId: 'v1',
  rpid: Number(over.rpidStr) || 0,
  mid: 1,
  midStr: '1',
  rootRpid: 0,
  parentRpid: 0,
  dialog: 0,
  replyLevel: 1,
  rootRpidStr: over.rpidStr,
  parentRpidStr: '',
  dialogStr: over.rpidStr,
  like: 0,
  replyCount: 0,
  ctime: 1000,
  uname: 'u',
  level: 0,
  createdAt: iso,
  updatedAt: iso,
  source: 'wbi-main',
  ...over,
});

beforeEach(async () => {
  await clearAll();
});

describe('prepareCommentAnalysis (V0.2 · P0-F)', () => {
  it('cleans, dedupes, and produces separated facts + sample', () => {
    const comments = [
      cm({ rpidStr: '1', content: '这个工具真的很好用 推荐', like: 10 }),
      cm({ rpidStr: '1', content: '重复 rpid 应被去掉', like: 0 }), // 同 rpidStr
      cm({ rpidStr: '2', content: 'a', like: 5 }), // 过短（<2）→ 清洗
      cm({ rpidStr: '3', content: '   ', like: 1 }), // 空白 → 清洗
      cm({ rpidStr: '4', content: '这个工具真的很好用 推荐', like: 3, uname: 'u' }), // 同用户同正文 → 去重
      cm({ rpidStr: '5', content: '价格太贵了 不推荐', like: 8 }),
    ];
    const input = prepareCommentAnalysis(comments);
    // 事实：用原始 6 条算
    expect(input.total).toBe(6);
    // 样本：去重后 1,2(过短被清),4(重复被去),5 → 剩 1 和 5
    expect(input.sample.map((s) => s.rpidStr).sort()).toEqual(['1', '5']);
    expect(input.droppedCount).toBeGreaterThan(0);
    expect(input.note).toContain('不含 AI 推断');
    // 关键词只保留出现 >1 次的词；本样本每词仅 1 次 → 关键词为空是正确行为
    expect(input.keywords).toEqual([]);
  });

  it('sample is prioritized by like then time, and truncated', () => {
    const comments = Array.from({ length: 10 }, (_, i) =>
      cm({ rpidStr: String(i + 1), content: `内容内容内容${i}`, like: i })
    );
    const input = prepareCommentAnalysis(comments, { sampleLimit: 3, contentLimit: 5 });
    expect(input.sample).toHaveLength(3);
    expect(input.sample[0]!.like).toBe(9); // 最高赞在前
    expect(input.sample[0]!.content.length).toBeLessThanOrEqual(5);
  });

  it('serializeCommentFacts emits facts-only JSON', () => {
    const input = prepareCommentAnalysis([cm({ rpidStr: '1', content: '很棒的评测', like: 5 })]);
    const json = JSON.parse(serializeCommentFacts(input));
    expect(json.stats.total).toBe(1);
    expect(json.topComments[0].rpid).toBe('1');
    expect(JSON.stringify(json)).not.toContain('explanations'); // 事实块不含推断
  });
});

describe('buildCommentAnalyzePrompt (V0.2 · P0-F)', () => {
  it('includes facts block separately and requires rpid citations', () => {
    const input = prepareCommentAnalysis([cm({ rpidStr: '7', content: '很好看的内容', like: 2 })]);
    const { system, user } = buildCommentAnalyzePrompt({
      videoId: 'v1',
      comments: [cm({ rpidStr: '7', content: '很好看的内容', like: 2 })],
      factsJson: serializeCommentFacts(input),
    });
    expect(system).toMatch(/rpid/);
    expect(system).toMatch(/不得编造数字/);
    const parsed = JSON.parse(user) as { facts: unknown; sample: Array<{ rpid: string }> };
    expect(parsed.facts).toBeTruthy();
    expect(parsed.sample[0]!.rpid).toBe('7');
  });

  it('works without factsJson (backward compatible)', () => {
    const { user } = buildCommentAnalyzePrompt({ videoId: 'v', comments: [] });
    const parsed = JSON.parse(user) as { facts?: unknown };
    expect(parsed.facts).toBeUndefined();
  });
});
