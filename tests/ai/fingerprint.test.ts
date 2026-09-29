/**
 * V3.1.1 · P0：Main Request 冻结 + requestFingerprint（MAIN-001..003）。
 *
 * 规格（任务书 §四）：
 *  - AI 开始时冻结 Main 请求的不可变快照（systemPrompt / userPrompt / temperature /
 *    maxTokens / structuredOutput / jsonSchema / stream / idleTimeoutMs / provider / model）；
 *  - fingerprintBefore === fingerprintAfter 必须被测试证明（Probe / adapter / 修复流程
 *    从未 mutate Main 请求对象）；
 *  - 指纹随结果与成功审计 meta 落库。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, db } from '@db/database';
import { orchestrate } from '@ai/orchestrator';
import {
  computeRequestFingerprint,
  stableRequestSerialization,
} from '@ai/fingerprint';
import type { CommentAIResult } from '@ai/schemas';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = 'biliscope.ai.providers.v1';

function saveCfg(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      activeProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          name: 'openai-compatible',
          baseUrl: 'https://openai.example/v1',
          apiKey: 'sk-openai',
          model: 'gpt-x',
        },
      },
    }),
  );
}

const GOOD: CommentAIResult = {
  summary: '评论区以正面为主',
  relevantFacts: ['高赞评论集中于画质讨论'],
  narratives: [
    { name: '画质认可', description: '高赞评论把画质视为核心优点', role: 'primary', refs: ['C001'] },
  ],
  audienceSegments: [],
  tensions: [
    { statement: '画质升级是否值得', sideA: '认可画质', sideB: '认为更新慢', refs: ['C001', 'C002'] },
  ],
  mechanisms: [
    {
      hypothesis: '画质对比可能是互动的主要驱动之一',
      explanation: '高互动样本集中于画质讨论而非其他话题',
      evidenceRefs: ['C001'],
      confidence: 'medium',
    },
  ],
  signalVsNoise: [
    { type: 'signal', statement: '画质被讨论', reason: '该评论提供具体的画质对比信息', refs: ['C001'] },
  ],
  contentImplications: [
    { insight: '互动主要由画质对比驱动', basisRefs: ['C001'], implication: '后续内容可延续画质对比角度' },
  ],
  claims: [{ statement: '认可画质', refs: ['C001'], confidence: 'medium' }],
  needs: ['提高更新频率'],
  questions: ['下期何时出'],
  uncertainty: ['样本量小'],
  hypothesesToTest: [
    {
      hypothesis: '画质讨论驱动互动',
      evidenceForRefs: ['C001'],
      evidenceAgainstRefs: [],
      missingEvidence: ['跨视频对比样本'],
      testMethod: '对同主题 5 个视频采集相同样本，比较画质讨论引用比例',
    },
  ],
  nextResearch: ['补充二级回复'],
};

const GOOD_JSON = JSON.stringify(GOOD);

const BASE_OPTS = {
  domain: 'comment' as const,
  targetId: 'v_fp',
  systemPrompt: 'sys-fp',
  userPrompt: 'user-fp',
  knownRefs: ['C001', 'C002'],
  citationMap: { C001: '101', C002: '102' },
};

const HEX64 = /^[0-9a-f]{64}$/;

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

// ── 单元层：序列化与哈希 ──
describe('V3.1.1 · fingerprint 单元语义', () => {
  it('序列化确定性：同字段同串；Auto/不限制 显式表达', () => {
    const a = stableRequestSerialization({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: undefined,
      idleTimeoutMs: null,
      provider: 'openai-compatible',
      model: 'gpt-x',
    });
    const b = stableRequestSerialization({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: undefined,
      idleTimeoutMs: null,
      provider: 'openai-compatible',
      model: 'gpt-x',
    });
    expect(a).toBe(b);
    expect(a).toContain('auto');
    expect(a).toContain('unlimited');
    // 显式值按原样进入
    const c = stableRequestSerialization({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 4096,
      idleTimeoutMs: 120_000,
      provider: 'openai-compatible',
      model: 'gpt-x',
    });
    expect(c).toContain('4096');
    expect(c).toContain('120000');
    expect(c).not.toBe(a);
  });

  it('SHA-256 哈希：同字段同哈希；任一字段变化 → 哈希变化（64 位 hex）', async () => {
    const base = {
      systemPrompt: 's',
      userPrompt: 'u',
      temperature: 0.2,
      maxTokens: undefined,
      structuredOutput: 'json_object' as const,
      jsonSchemaName: 'bili_comment_analysis',
      stream: false,
      idleTimeoutMs: null,
      provider: 'openai-compatible',
      model: 'gpt-x',
    };
    const h1 = await computeRequestFingerprint(base);
    const h2 = await computeRequestFingerprint({ ...base });
    expect(h1).toBe(h2);
    expect(h1).toMatch(HEX64);
    // prompt 变化 → 哈希变化
    const h3 = await computeRequestFingerprint({ ...base, userPrompt: 'u2' });
    expect(h3).not.toBe(h1);
    // maxTokens Auto → 显式值：哈希变化（禁止把 Auto 偷换成具体值而不被发现）
    const h4 = await computeRequestFingerprint({ ...base, maxTokens: 4096 });
    expect(h4).not.toBe(h1);
    // idleTimeoutMs null（不限制）→ number：哈希变化
    const h5 = await computeRequestFingerprint({ ...base, idleTimeoutMs: 120_000 });
    expect(h5).not.toBe(h1);
  });
});

// ── 集成层：orchestrate 的 before === after 证明 ──
describe('V3.1.1 · Main Request 冻结（MAIN-001..003）', () => {
  it('MAIN-001: 成功路径 —— 指纹随结果返回；审计 meta before === after === 结果指纹', async () => {
    saveCfg();
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
        max_tokens?: number;
      };
      const isProbe =
        body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
      if (isProbe) {
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: GOOD_JSON } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    // 显式固定会进指纹的可变项，验证逐字段冻结
    const r = await orchestrate({ ...BASE_OPTS, maxTokens: 4096, idleTimeoutMs: 120_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requestFingerprint).toMatch(HEX64);

    const audits = await db.aiAnalyses.toArray();
    const analysisRow = audits.find((a) => a.requestType !== 'probe');
    expect(analysisRow).toBeTruthy();
    const meta = ((analysisRow!.parsedResult as Record<string, unknown>).__meta ?? {}) as Record<
      string,
      unknown
    >;
    expect(meta.requestFingerprintBefore).toMatch(HEX64);
    expect(meta.requestFingerprintAfter).toMatch(HEX64);
    // ★ 规格硬性要求：before === after（Probe / adapter 从未 mutate Main 请求）
    expect(meta.requestFingerprintBefore).toBe(meta.requestFingerprintAfter);
    expect(meta.requestFingerprintAfter).toBe(r.requestFingerprint);
  });

  it('MAIN-002: 失败路径（OUTPUT_TRUNCATED）同样携带指纹，且失败只归因 Main 自己', async () => {
    saveCfg();
    const truncated = '{"summary":"这是一段被截断的输出","facts":["a"';
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
        max_tokens?: number;
      };
      const isProbe =
        body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
      if (isProbe) {
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'max_tokens', message: { content: truncated } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('OUTPUT_TRUNCATED');
    // 失败结果同样带指纹（暂停/继续一致性验证的数据基础）
    expect(r.requestFingerprint).toMatch(HEX64);
  });

  it('MAIN-003: 自动修复流程不 mutate Main 请求（修复后 before === after 仍成立）', async () => {
    saveCfg();
    // 第 1 次 Main 返回非法 JSON → 触发一次修复；第 2 次（修复请求）返回 GOOD
    let mainCalls = 0;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
        max_tokens?: number;
      };
      const isProbe =
        body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
      if (isProbe) {
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      mainCalls++;
      const content = mainCalls === 1 ? '{"summary": 不是合法 JSON' : GOOD_JSON;
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(mainCalls).toBe(2);

    const audits = await db.aiAnalyses.toArray();
    const analysisRow = audits.find((a) => a.requestType !== 'probe');
    const meta = ((analysisRow!.parsedResult as Record<string, unknown>).__meta ?? {}) as Record<
      string,
      unknown
    >;
    // ★ 修复请求是独立新对象；Main 原请求对象在修复前后指纹一致
    expect(meta.requestFingerprintBefore).toBe(meta.requestFingerprintAfter);
    expect(meta.requestFingerprintAfter).toBe(r.requestFingerprint);
  });
});
