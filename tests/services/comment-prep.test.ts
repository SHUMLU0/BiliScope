import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '@db/database';
import {
  prepareCommentAnalysis,
  serializeCommentFacts,
  DEFAULT_SAMPLE_LIMIT,
} from '@services/comment-prep';
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
      // V3.0.1 · P0-1：prompt 只接收 prepare 层产出的受控样本
      sample: input.sample,
      totalComments: input.total,
      factsJson: serializeCommentFacts(input),
    });
    expect(system).toMatch(/rpid/);
    // V3.0：反编造约束统一为「禁止编造数字 / 不得编造数字」两种等价措辞
    expect(system).toMatch(/不得编造数字|禁止编造数字/);
    const parsed = JSON.parse(user) as { facts: unknown; sample: Array<{ rpid: string }> };
    expect(parsed.facts).toBeTruthy();
    expect(parsed.sample[0]!.rpid).toBe('7');
  });

  it('works without factsJson (backward compatible)', () => {
    const { user } = buildCommentAnalyzePrompt({ videoId: 'v', sample: [] });
    const parsed = JSON.parse(user) as { facts?: unknown };
    expect(parsed.facts).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────── V3.0.1 · P0-1 性能
describe('V3.0.1 · P0-1 AI 输入受控（统计基数 ≠ AI 样本）', () => {
  /** 造 200 条评论，like 递增（保证可预测排序） */
  const many = (n: number): Comment[] =>
    Array.from({ length: n }, (_, i) =>
      cm({
        rpidStr: String(1000 + i),
        content: `这是第 ${i} 条评论的正文内容，足够长以避免被清洗掉。`,
        like: i,
        ctime: 1_700_000_000 + i,
      }),
    );

  it('AI-PERF-001: 200 comments → stats uses all 200, AI sample is capped at the default 120', () => {
    const comments = many(200);
    const input = prepareCommentAnalysis(comments);

    // 统计基于**全部已采集数据**
    expect(input.total).toBe(200);
    expect(input.stats.total).toBe(200);

    // AI 样本受控：≤ 默认 120
    expect(input.sample.length).toBeLessThanOrEqual(DEFAULT_SAMPLE_LIMIT);
    expect(input.sample.length).toBe(DEFAULT_SAMPLE_LIMIT);
    expect(input.budget.sampleCount).toBe(DEFAULT_SAMPLE_LIMIT);
    expect(input.budget.sampleChars).toBeGreaterThan(0);
    expect(input.budget.factsChars).toBeGreaterThan(0);
    expect(input.budget.totalChars).toBe(input.budget.sampleChars + input.budget.factsChars);
  });

  it('AI-PERF-002: the AI 样本段 NEVER contains comments beyond the sample', () => {
    const comments = many(200);
    // 故意把上限压到 5，便于精确定位「第 6 条是否泄漏」
    const prep = prepareCommentAnalysis(comments, { sampleLimit: 5 });
    expect(prep.sample).toHaveLength(5);

    const { user } = buildCommentAnalyzePrompt({
      videoId: 'v1',
      sample: prep.sample,
      totalComments: prep.total,
      factsJson: serializeCommentFacts(prep),
    });

    const parsedPrompt = JSON.parse(user) as {
      sample: Array<{ rpid: string }>;
      sampleCount: number;
      totalComments: number;
      facts: unknown;
    };

    // ① 送入 AI 的 sample 段条数必须等于受控上限，且 rpid 全在样本内
    expect(parsedPrompt.sample).toHaveLength(5);
    expect(parsedPrompt.sampleCount).toBe(5);
    expect(parsedPrompt.totalComments).toBe(200);
    const sampleIds = new Set(prep.sample.map((s) => s.rpidStr));
    for (const s of parsedPrompt.sample) expect(sampleIds.has(s.rpid)).toBe(true);

    // ② 样本之外的评论正文不得出现在 sample 段（V3.0.0 slice(0,200) 的缺陷）
    const sampleContents = prep.sample.map((s) => s.content);
    const sampleJson = JSON.stringify(parsedPrompt.sample);
    for (const c of comments) {
      if (sampleIds.has(c.rpidStr)) continue;
      // 非样本评论的正文不得整句出现在 sample 段
      expect(sampleJson.includes(c.content)).toBe(false);
    }

    // ③ 事实块（facts）是独立段：它按设计保留全量统计与高赞摘要，不属于「AI 样本」
    expect(parsedPrompt.facts).toBeTruthy();
    expect(sampleContents.length).toBe(5);
  });

  it('P0-1: 高赞 / 最新 / 多样性 三种策略产出不同的样本', () => {
    const comments = many(30);

    const hot = prepareCommentAnalysis(comments, { sampleLimit: 5, sampleStrategy: 'hot' });
    // 高赞策略：like 最高的在最前
    expect(hot.sample[0]!.like).toBe(29);
    expect(hot.sampleStrategy).toBe('hot');

    const latest = prepareCommentAnalysis(comments, { sampleLimit: 5, sampleStrategy: 'latest' });
    // 最新策略：ctime 最大的在最前
    expect(latest.sample[0]!.ctime).toBe(1_700_000_000 + 29);
    expect(latest.sampleStrategy).toBe('latest');

    const diverse = prepareCommentAnalysis(comments, { sampleLimit: 5, sampleStrategy: 'diverse' });
    // 多样性策略：不应等同于纯高赞 Top5
    const hotIds = hot.sample.map((s) => s.rpidStr).join(',');
    const diverseIds = diverse.sample.map((s) => s.rpidStr).join(',');
    expect(diverse.sampleStrategy).toBe('diverse');
    expect(diverse.sample).toHaveLength(5);
    expect(diverseIds).not.toBe(hotIds);
  });

  it('P0-1: 采样策略不影响统计事实', () => {
    const comments = many(200);
    const a = prepareCommentAnalysis(comments, { sampleStrategy: 'hot' });
    const b = prepareCommentAnalysis(comments, { sampleStrategy: 'latest' });
    const c = prepareCommentAnalysis(comments, { sampleStrategy: 'diverse' });
    // 三种策略下统计完全一致（统计与抽样严格分区）
    expect(a.stats.total).toBe(b.stats.total);
    expect(b.stats.total).toBe(c.stats.total);
    expect(a.total).toBe(c.total);
  });
});
