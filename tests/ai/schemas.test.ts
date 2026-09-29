/**
 * V3.0/V3.2 · 领域 schema 契约测试。
 *
 * ⚠️ 这组测试的目的**不是**证明「模型能返回 JSON」，而是证明：
 *   「返回的东西必须符合 BiliScope 的业务契约，否则一律判为失败」。
 *
 * V3.2.0（Comment Research Analyst）：新增 AI-RESEARCH-001..009 契约断言 ——
 *   输出必须是「研究判断」，不是「事实复述 + 分类」。
 */

import { describe, expect, it } from 'vitest';
import {
  commentAIResultSchema,
  generalAIResultSchema,
  narrativeSchema,
  mechanismSchema,
  signalNoiseSchema,
  hypothesisToTestSchema,
  validateAIResult,
  unwrapAIResult,
  forEachResultRefs,
  DOMAIN_SCHEMAS,
} from '@ai/schemas';

const validResult = {
  summary: '评论区的核心冲突是「单一事件能否作为整体结论的证据」，而非事件本身。',
  relevantFacts: ['高赞评论明显集中于预算与组织话题，且该话题同时出现在多个叙事中'],
  narratives: [
    { name: '整体结论之争', description: '支持方把局部事件上升为整体判断', role: 'primary' as const, refs: ['C001', 'C008'] },
    { name: '崩溃论未兑现', description: '反对方质疑从局部推导整体的逻辑', role: 'counter' as const, refs: ['C011'] },
  ],
  audienceSegments: [
    { name: '信息求证者', need: '想要可核验的数据来源', behavior: '引用具体数字并追问出处', refs: ['C017'] },
  ],
  tensions: [
    { statement: '单一事件能否作为整体结论的证据', sideA: '可以，事件反映治理能力', sideB: '不可以，这是逻辑跳跃', refs: ['C001', 'C011'] },
  ],
  mechanisms: [
    {
      hypothesis: '整体结论框架可能是评论互动的主要放大器之一',
      explanation: '多个高互动样本不是讨论事件细节，而是把具体问题连接到整体叙事',
      evidenceRefs: ['C001', 'C008'],
      confidence: 'medium' as const,
    },
  ],
  signalVsNoise: [
    { type: 'signal' as const, statement: '为什么资源不足还要硬承接？', reason: '该评论提出承办意愿与资源约束的因果问题', refs: ['C017'] },
    { type: 'noise' as const, statement: '赢麻了', reason: '纯情绪表态，不提供新事实或逻辑', refs: ['C002'] },
  ],
  contentImplications: [
    { insight: '互动可能更多由整体比较与情绪立场驱动', basisRefs: ['C001', 'C002'], implication: '同类内容的研究应区分事实讨论与立场表达' },
  ],
  claims: [
    { statement: '高赞讨论围绕整体叙事而非事件细节', refs: ['C001', 'C008'], confidence: 'medium' as const },
  ],
  needs: ['希望看到可核验的数据来源'],
  questions: ['这个判断的数据从哪来？'],
  uncertainty: ['仅抽取 120 条，存在抽样偏差'],
  hypothesesToTest: [
    {
      hypothesis: '评论互动主要由整体叙事驱动',
      evidenceForRefs: ['C001', 'C008'],
      evidenceAgainstRefs: ['C011'],
      missingEvidence: ['无法确认该模式是否在不同视频中稳定出现'],
      testMethod: '对 5-10 个同主题视频采集相同样本，比较事实讨论与整体叙事的引用比例',
    },
  ],
  nextResearch: ['补充采集反叙事参与者的二级回复'],
};

describe('commentAIResultSchema（领域契约 · V3.2 Research Analyst）', () => {
  it('accepts a fully-formed research result', () => {
    const r = commentAIResultSchema.safeParse(validResult);
    expect(r.success).toBe(true);
  });

  it('rejects wrong narrative.role enum value', () => {
    const bad = {
      ...validResult,
      narratives: [{ name: 'x', description: 'y', role: 'main', refs: [] }],
    };
    const r = commentAIResultSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('AI-RESEARCH-003: narratives carry anonymous refs (C001 style)', () => {
    const r = commentAIResultSchema.parse(validResult);
    for (const n of r.narratives) {
      expect(Array.isArray(n.refs)).toBe(true);
      for (const ref of n.refs) expect(ref).toMatch(/^C\d+/);
    }
    const bad = narrativeSchema.safeParse({ name: 'x', description: 'y', role: 'primary', refs: 'C001' });
    expect(bad.success).toBe(false);
  });

  it('AI-RESEARCH-004: tensions require sideA/sideB structure', () => {
    const r = commentAIResultSchema.parse(validResult);
    expect(r.tensions[0]!.sideA.length).toBeGreaterThan(0);
    expect(r.tensions[0]!.sideB.length).toBeGreaterThan(0);
    const bad = commentAIResultSchema.safeParse({
      ...validResult,
      tensions: [{ statement: '缺少一方', sideA: '只有A', refs: ['C001'] }],
    });
    expect(bad.success).toBe(false);
  });

  it('AI-RESEARCH-005: mechanisms must carry a bounded confidence enum', () => {
    const r = mechanismSchema.safeParse({
      hypothesis: 'h',
      explanation: 'e',
      evidenceRefs: ['C001'],
      confidence: 'certain',
    });
    expect(r.success).toBe(false);
    const ok = mechanismSchema.safeParse({
      hypothesis: 'h',
      explanation: 'e',
      evidenceRefs: ['C001'],
      confidence: 'medium',
    });
    expect(ok.success).toBe(true);
  });

  it('AI-RESEARCH-007: signal/noise entries must state a reason', () => {
    const bad = signalNoiseSchema.safeParse({ type: 'noise', statement: '哈哈哈', reason: '' });
    expect(bad.success).toBe(false);
    const ok = signalNoiseSchema.safeParse({ type: 'noise', statement: '哈哈哈', reason: '纯情绪表态', refs: ['C002'] });
    expect(ok.success).toBe(true);
  });

  it('AI-RESEARCH-008: hypotheses require a test method', () => {
    const bad = hypothesisToTestSchema.safeParse({
      hypothesis: 'h',
      evidenceForRefs: [],
      evidenceAgainstRefs: [],
      missingEvidence: [],
      testMethod: '',
    });
    expect(bad.success).toBe(false);
  });

  it('AI-RESEARCH-009: relevantFacts is capped at 5 (prevents fact-dumping)', () => {
    const six = Array.from({ length: 6 }, (_, i) => `事实 ${i + 1}`);
    const bad = commentAIResultSchema.safeParse({ ...validResult, relevantFacts: six });
    expect(bad.success).toBe(false);
    const ok = commentAIResultSchema.safeParse({ ...validResult, relevantFacts: six.slice(0, 5) });
    expect(ok.success).toBe(true);
  });

  it('defaults missing optional arrays to [] rather than failing', () => {
    const r = commentAIResultSchema.safeParse({
      summary: '结论',
      claims: [{ statement: '判断', refs: ['C001'], confidence: 'low' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.narratives).toEqual([]);
      expect(r.data.tensions).toEqual([]);
      expect(r.data.uncertainty).toEqual([]);
    }
  });

  it('V3.0 反「幽灵成功」：无关 JSON 不得被补全成全空结果', () => {
    const r = commentAIResultSchema.safeParse({ ok: 1 });
    expect(r.success).toBe(false);
  });

  it('V3.0 结构签名：validateAIResult 对无关 JSON 判 OUTPUT_SCHEMA_INVALID', () => {
    const r = validateAIResult('comment', { ok: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('OUTPUT_SCHEMA_INVALID');
      expect(r.issues.join(' ')).toMatch(/骨架字段|ok/);
    }
    expect(validateAIResult('comment', [1, 2]).ok).toBe(false);
    expect(validateAIResult('creator', 'plain text').ok).toBe(false);
  });

  it('V3.0 结构签名：包裹式结果解包后仍可识别', () => {
    const wrapped = { result: validResult };
    const r = validateAIResult('comment', unwrapAIResult(wrapped));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.summary).toBe(validResult.summary);
  });

  it('generalAIResultSchema requires explanations for creator/video domains', () => {
    const r = generalAIResultSchema.safeParse({
      summary: 's',
      facts: ['f'],
      explanations: ['可能因为 X'],
      uncertainty: ['数据不足'],
      nextResearch: ['补充快照'],
    });
    expect(r.success).toBe(true);
  });
});

describe('AI-RESEARCH-001/002 · Summarizer 行为拒绝（schema 化）', () => {
  it('AI-RESEARCH-001: 只输出事实复述（summary + relevantFacts，无任何研究判断字段）→ 拒绝', () => {
    const r = commentAIResultSchema.safeParse({
      summary: '很多人讨论了预算问题。',
      relevantFacts: ['样本 120 条', '最高赞 320', '时间跨度 30 天'],
      needs: ['希望更多数据'],
      questions: ['数据来源是什么？'],
      uncertainty: ['样本量小'],
      nextResearch: ['补充采集'],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/研究判断|事实复述/);
    }
  });

  it('AI-RESEARCH-002: 至少一个带 evidenceRefs 的研究判断字段 → 通过', () => {
    const r = commentAIResultSchema.parse(validResult);
    // mechanisms / contentImplications / hypotheses 都是带证据引用的判断字段
    expect(r.mechanisms[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(r.contentImplications[0]!.basisRefs.length).toBeGreaterThan(0);
    const anyFinding = validateAIResult('comment', validResult);
    expect(anyFinding.ok).toBe(true);
  });

  it('uncertain-only output (uncertainty/needs only) is also rejected as non-research', () => {
    const r = commentAIResultSchema.safeParse({
      summary: '样本不足，无法判断。',
      uncertainty: ['样本量小'],
    });
    expect(r.success).toBe(false);
  });
});

describe('forEachResultRefs（引用审计与 UI 高亮的统一口径）', () => {
  it('visits every ref array across all research fields', () => {
    const seen: string[][] = [];
    forEachResultRefs(validResult as never, (refs) => seen.push(refs));
    // narratives 2 + audienceSegments 1 + tensions 1 + mechanisms 1 + signalVsNoise 2 +
    // contentImplications 1 + claims 1 + hypotheses 2 = 11 组
    expect(seen).toHaveLength(11);
    const flat = seen.flat();
    expect(flat).toContain('C011'); // 反叙事 ref（evidenceAgainstRefs）
    expect(flat).toContain('C002'); // 噪声 ref
  });
});

describe('validateAIResult（分层校验）', () => {
  it('returns ok=true with typed data', () => {
    const r = validateAIResult('comment', validResult);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toHaveProperty('summary');
  });

  it('returns ok=false with OUTPUT_SCHEMA_INVALID on bad shape', () => {
    const r = validateAIResult('comment', { summary: 'x', narratives: 'not-an-array' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('OUTPUT_SCHEMA_INVALID');
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('every registered domain has a schema', () => {
    expect(Object.keys(DOMAIN_SCHEMAS).sort()).toEqual(['comment', 'creator', 'idea', 'video']);
  });
});

describe('unwrapAIResult', () => {
  it('unwraps a single-level { result: {...} } wrapper', () => {
    const r = unwrapAIResult({ result: validResult });
    expect(r).toEqual(validResult);
  });

  it('does not unwrap when outer object already has core fields', () => {
    const obj = { summary: 's', relevantFacts: [], nested: { a: 1 } };
    expect(unwrapAIResult(obj)).toEqual(obj);
  });

  it('passes through non-objects unchanged', () => {
    expect(unwrapAIResult('x')).toBe('x');
    expect(unwrapAIResult(null)).toBeNull();
    expect(unwrapAIResult([1, 2])).toEqual([1, 2]);
  });
});
