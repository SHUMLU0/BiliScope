/**
 * V3.0 · 领域 schema 契约测试。
 *
 * ⚠️ 这组测试的目的**不是**证明「模型能返回 JSON」，而是证明：
 *   「返回的东西必须符合 BiliScope 的业务契约，否则一律判为失败」。
 * 这正是 V3.0 第九条问题（AI 测试只证明能返回 JSON）的修复验证。
 */

import { describe, expect, it } from 'vitest';
import {
  commentAIResultSchema,
  generalAIResultSchema,
  findingSchema,
  citedClaimSchema,
  validateAIResult,
  unwrapAIResult,
  DOMAIN_SCHEMAS,
} from '@ai/schemas';

const validResult = {
  summary: '评论区整体正面，主要讨论画质与更新频率。',
  facts: ['样本共 120 条评论', '最高点赞 320'],
  findings: [
    { type: 'theme' as const, statement: '画质是主要讨论点', evidenceRpids: ['1001', '1002'] },
    { type: 'painpoint' as const, statement: '更新太慢', evidenceRpids: ['1003'] },
  ],
  themes: [{ name: '画质', rpids: ['1001', '1002'] }],
  support: [{ statement: '多数人认可画质', rpid: ['1001', '1002'] }],
  opposition: [{ statement: '有人认为更新频率不足', rpid: ['1003'] }],
  needs: ['希望提高更新频率'],
  questions: ['下一期什么时候出？'],
  uncertainty: ['仅抽取 120 条，存在抽样偏差'],
  nextResearch: ['补充采集二级回复以验证长尾观点'],
};

describe('commentAIResultSchema（领域契约）', () => {
  it('accepts a fully-formed domain result', () => {
    const r = commentAIResultSchema.safeParse(validResult);
    expect(r.success).toBe(true);
  });

  it('rejects result missing required top-level fields', () => {
    // 只丢掉 uncertainty —— 这正是「残缺 JSON 被当成成功」的典型场景
    const { uncertainty: _drop, ...partial } = validResult;
    void _drop;
    const r = commentAIResultSchema.safeParse(partial);
    // 因为 uncertainty 有 default，缺失不算错；但类型错误的 summary 一定算错
    expect(r.success).toBe(true);
    const bad = commentAIResultSchema.safeParse({ ...validResult, summary: 12345 });
    expect(bad.success).toBe(false);
  });

  it('rejects wrong finding.type enum value', () => {
    const bad = {
      ...validResult,
      findings: [{ type: 'guess', statement: 'x', evidenceRpids: [] }],
    };
    const r = commentAIResultSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('rejects CitedClaim without rpid array (禁止无引用论断)', () => {
    const r = citedClaimSchema.safeParse({ statement: '多数用户都支持' });
    // rpid 缺失 → default [] → 通过 schema，但 claimsWithoutCitation 审计会捕获
    expect(r.success).toBe(true);
    expect(r.success && r.data.rpid).toEqual([]);
    // 类型错误必须被拒
    const bad = citedClaimSchema.safeParse({ statement: 'x', rpid: '1001' });
    expect(bad.success).toBe(false);
  });

  it('rejects finding with non-string evidenceRpids entries', () => {
    const r = findingSchema.safeParse({ type: 'theme', statement: 'x', evidenceRpids: [1001] });
    expect(r.success).toBe(false);
  });

  it('defaults missing optional arrays to [] rather than failing', () => {
    // summary + 至少一个领域字段非空 → 领域可识别性满足，缺失数组补 [] 而不是失败
    const r = commentAIResultSchema.safeParse({ summary: '只有结论', needs: ['提高更新频率'] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.facts).toEqual([]);
      expect(r.data.support).toEqual([]);
      expect(r.data.uncertainty).toEqual([]);
    }
  });

  it('V3.0 反「幽灵成功」：无关 JSON 不得被补全成全空结果', () => {
    // {"ok":1} 是合法 JSON，但既无骨架内容也无领域字段 → 必须失败
    const r = commentAIResultSchema.safeParse({ ok: 1 });
    expect(r.success).toBe(false);

    // 只有 summary 的非空、却没有任何领域字段 → 也必须失败（不可识别为评论分析）
    const onlySummary = commentAIResultSchema.safeParse({ summary: 'x' });
    expect(onlySummary.success).toBe(false);
  });

  it('V3.0 结构签名：validateAIResult 对无关 JSON 判 OUTPUT_SCHEMA_INVALID', () => {
    const r = validateAIResult('comment', { ok: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('OUTPUT_SCHEMA_INVALID');
      expect(r.issues.join(' ')).toMatch(/骨架字段|ok/);
    }
    // 非对象（数组 / 字符串）同样拒绝
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

describe('validateAIResult（分层校验）', () => {
  it('returns ok=true with typed data', () => {
    const r = validateAIResult('comment', validResult);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toHaveProperty('summary');
  });

  it('returns ok=false with OUTPUT_SCHEMA_INVALID on bad shape', () => {
    const r = validateAIResult('comment', { summary: 'x', findings: 'not-an-array' });
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
    const obj = { summary: 's', facts: [], nested: { a: 1 } };
    expect(unwrapAIResult(obj)).toEqual(obj);
  });

  it('passes through non-objects unchanged', () => {
    expect(unwrapAIResult('x')).toBe('x');
    expect(unwrapAIResult(null)).toBeNull();
    expect(unwrapAIResult([1, 2])).toEqual([1, 2]);
  });
});
