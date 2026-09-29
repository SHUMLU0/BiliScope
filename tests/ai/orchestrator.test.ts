/**
 * V3.0 · Orchestrator 集成测试。
 *
 * 覆盖（用户强制清单）：
 *  - 领域契约（不是「能返回 JSON」）
 *  - 截断（OUTPUT_TRUNCATED）
 *  - 无效 JSON（OUTPUT_INVALID_JSON）
 *  - schema 不符（OUTPUT_SCHEMA_INVALID）
 *  - 拒答（OUTPUT_REFUSAL）
 *  - 自动修复仅一次（总请求 ≤ 2，禁止循环）
 *  - 引用校验（unknownRpids / claimsWithoutCitation）
 *  - Provider 名与端点不错配
 *  - 失败绝不写 CommentAnalysis（不留半成品）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, db } from '@db/database';
import { orchestrate, auditCitations, mapToCommentAnalysis } from '@ai/orchestrator';
import { getProviderConfig } from '@ai/settings';
import type { CommentAIResult } from '@ai/schemas';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = 'biliscope.ai.providers.v1';

function saveCfg(active = 'openai-compatible', extra: Record<string, unknown> = {}): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      activeProvider: active,
      providers: {
        'openai-compatible': {
          name: 'openai-compatible',
          baseUrl: 'https://openai.example/v1',
          apiKey: 'sk-openai',
          model: 'gpt-x',
        },
        deepseek: {
          name: 'deepseek',
          baseUrl: 'https://deepseek.example/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
        },
        ...extra,
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

/** 让 fetch 依次返回给定的 OpenAI 风格响应 */
function mockSequence(responses: Array<{ content: string; finish_reason?: string; status?: number }>): {
  calls: () => number;
  urls: () => string[];
  headers: () => Array<Record<string, string>>;
  bodies: () => Record<string, unknown>[];
} {
  let i = 0;
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r.status && r.status >= 400) {
      return new Response('err', { status: r.status });
    }
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${i}`,
        model: 'gpt-x',
        choices: [{ finish_reason: r.finish_reason ?? 'stop', message: { content: r.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls: () => i, urls: () => urls, headers: () => headers, bodies: () => bodies };
}

/**
 * 语义更清晰的 mock：按「首次请求 / 修复请求」分别给响应。
 *   first  → max_tokens === 4096（任务默认）
 *   repair → max_tokens === 4096 且 temperature === 0（修复请求用 0 温度）
 * 两者都以 temperature 区分：首次请求 temperature=0.2，修复请求 temperature=0。
 */
function mockByPhase(
  first: { content: string; finish_reason?: string },
  repair: { content: string; finish_reason?: string },
): { calls: () => number } {
  let i = 0;
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { temperature?: number };
    const isRepair = body.temperature === 0;
    const r = isRepair ? repair : first;
    i++;
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${i}`,
        model: 'gpt-x',
        choices: [{ finish_reason: r.finish_reason ?? 'stop', message: { content: r.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls: () => i };
}

const BASE_OPTS = {
  domain: 'comment' as const,
  targetId: 'v_test',
  systemPrompt: 'sys',
  userPrompt: 'user',
  // V3.1.0：白名单 = 模型可见的匿名 ref
  knownRefs: ['C001', 'C002', 'C003'],
  // V3.1.0：ref → 真实 rpid 本地映射（落库回溯用）
  citationMap: { C001: '101', C002: '102', C003: '103' },
  // V3.0.2：本文件的既有用例全部使用 `single` 策略（V3.0.1 旧行为、不发 Probe），
  // 保证「调用次数 / 请求顺序」断言语义不变。probe_guarded 的专项测试见 probes.test.ts。
  requestStrategy: 'single' as const,
};

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

describe('orchestrate · 成功路径', () => {
  it('returns typed SUCCESS and writes CommentAnalysis (产品结果)', async () => {
    saveCfg();
    mockSequence([{ content: JSON.stringify(GOOD) }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('SUCCESS');
    expect(r.data.summary).toBe('评论区以正面为主');
    expect(r.requestCount).toBe(1);
    expect(r.repaired).toBe(false);
    expect(r.incomplete).toBe(false);
    // 产品结果必须落库
    expect(r.domainRecordId).toBeTruthy();
    const stored = await db.commentAnalyses.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.videoId).toBe('v_test');
    // 审计记录也必须落库
    const audits = await db.aiAnalyses.toArray();
    expect(audits).toHaveLength(1);
  });

  it('does NOT treat "valid JSON but not a domain result" as success', async () => {
    saveCfg();
    // {"ok":1} 是合法 JSON，但不是评论分析结果 → 必须走一次修复
    const cap = mockByPhase({ content: '{"ok":1}' }, { content: JSON.stringify(GOOD) });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.requestCount).toBe(2);
    }
    expect(cap.calls()).toBe(2);
  });

  it('AI-LIMIT-001: orchestrate Auto = request body omits max_tokens (task default hardcode removed)', async () => {
    saveCfg();
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(GOOD) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    // V3.0.2：未显式指定输出上限（且 Provider 未配置 maxTokens）→ Auto：
    // 请求体**不携带** max_tokens —— 4096 任务级硬编码已废除
    expect(bodies[0]!.max_tokens).toBeUndefined();
    expect('max_tokens' in bodies[0]!).toBe(false);
  });

  it('uses an explicit maxTokens override', async () => {
    saveCfg();
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(GOOD) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await orchestrate({ ...BASE_OPTS, maxTokens: 8192 });
    expect(bodies[0]!.max_tokens).toBe(8192);
  });
});

// ─────────────────────────────────────────────────────────── V3.0.1 · P0-2 持久化
describe('V3.0.1 · P0-2 产品结果持久化语义', () => {
  it('AI-STORE-001: SUCCESS persists the Zod-validated structured result (not the raw response)', async () => {
    saveCfg();
    mockSequence([{ content: JSON.stringify(GOOD) }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);

    const stored = (await db.commentAnalyses.toArray())[0]!;
    // 结构化业务结果必须落库，且内容完整可读
    expect(stored.analysisResult).toBeTruthy();
    expect(stored.analysisResult!.summary).toBe('评论区以正面为主');
    expect(stored.analysisResult!.claims[0]!.statement).toBe('认可画质');
    expect(stored.analysisResult!.narratives[0]!.name).toBe('画质认可');
    // V3.2.0 · AI-META：产品结果必须关联 Main 审计行（refresh 后恢复真实元数据）
    const audits = (await db.aiAnalyses.toArray()).filter((a) => a.requestType !== 'probe');
    expect(stored.auditId).toBeTruthy();
    expect(stored.auditId).toBe(audits[0]!.id);

    // rawResponse 是 Provider 原始响应（OpenAI 风格），**不是**业务结果
    const raw = stored.rawResponse as { choices?: unknown[] } | undefined;
    expect(raw).toBeTruthy();
    expect(Array.isArray(raw!.choices)).toBe(true);
    // 两个字段语义必须不同：原始响应里没有 summary/support
    expect((raw as Record<string, unknown>).summary).toBeUndefined();
    expect((stored.rawResponse as unknown) === stored.analysisResult).toBe(false);
  });

  it('AI-STORE-002: refresh re-reads analysisResult and still shows the full report', async () => {
    saveCfg();
    mockSequence([{ content: JSON.stringify(GOOD) }]);
    await orchestrate(BASE_OPTS);

    // 模拟 UI 的 loadStoredReport：从库里按 videoId 读最新一条
    const list = await db.commentAnalyses.where('videoId').equals('v_test').reverse().sortBy('createdAt');
    const latest = list[0]!;
    const restored = latest.analysisResult!;
    expect(restored.summary).toBe('评论区以正面为主');
    expect(restored.narratives).toHaveLength(1);
    expect(restored.tensions).toHaveLength(1);
    expect(restored.claims).toHaveLength(1);
    expect(restored.hypothesesToTest).toHaveLength(1);
    expect(restored.hypothesesToTest[0]!.testMethod).toBe('对同主题 5 个视频采集相同样本，比较画质讨论引用比例');
    expect(restored.needs).toEqual(['提高更新频率']);
    expect(restored.questions).toEqual(['下期何时出']);
    expect(restored.uncertainty).toEqual(['样本量小']);
    expect(restored.nextResearch).toEqual(['补充二级回复']);
  });

  it('AI-STORE-003: the Provider raw response is never mistaken for a CommentAIResult', async () => {
    saveCfg();
    mockSequence([{ content: JSON.stringify(GOOD) }]);
    await orchestrate(BASE_OPTS);

    const stored = (await db.commentAnalyses.toArray())[0]!;
    // 旧实现会把 rawResponse 强转成 CommentAIResult —— 那样拿到的字段全是 undefined
    const wrongCast = stored.rawResponse as Record<string, unknown>;
    expect(wrongCast.summary).toBeUndefined();
    expect(wrongCast.tensions).toBeUndefined();
    expect(wrongCast.claims).toBeUndefined();
    // 正确来源才有这些字段
    expect(stored.analysisResult!.summary).toBeTruthy();
  });

  it('AI-STORE-004: a later AI failure keeps the previous SUCCESS row intact', async () => {
    // 第一次：成功
    saveCfg();
    mockSequence([{ content: JSON.stringify(GOOD) }]);
    const ok = await orchestrate(BASE_OPTS);
    expect(ok.ok).toBe(true);
    expect(await db.commentAnalyses.count()).toBe(1);
    const goodId = (await db.commentAnalyses.toArray())[0]!.id;

    // 第二次：限流失败 —— 不得删除 / 覆盖上一次成功结果
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limit exceeded', { status: 429 })) as unknown as typeof fetch;
    const bad = await orchestrate(BASE_OPTS);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe('REQUEST_RATE_LIMITED');

    const rows = await db.commentAnalyses.toArray();
    expect(rows).toHaveLength(1); // 仍是最初那条成功记录
    expect(rows[0]!.id).toBe(goodId);
    expect(rows[0]!.analysisResult!.summary).toBe('评论区以正面为主');
  });

  it('P0-2 兼容性：V3.0.0 旧记录（无 analysisResult）不会被补全成假结果', async () => {
    // 手工写入一条「旧版本」记录：只有 rawResponse，没有 analysisResult
    await db.commentAnalyses.add({
      id: 'ca_legacy',
      videoId: 'v_legacy',
      createdAt: new Date(0).toISOString(),
      model: 'gpt-x',
      factSummary: '',
      themeResult: [],
      sentimentResult: { positive: 0, neutral: 0, negative: 0 },
      userNeedResult: [],
      questionResult: [],
      supportResult: [],
      oppositionResult: [],
      citedCommentRpids: [],
      uncertaintyNote: '',
      rawResponse: { choices: [{ message: { content: '{"summary":"old"}' } }] },
    } as never);

    const rows = await db.commentAnalyses.where('videoId').equals('v_legacy').toArray();
    expect(rows).toHaveLength(1);
    // 关键：不得从 rawResponse 猜测结构化结果
    expect(rows[0]!.analysisResult).toBeUndefined();
  });
});

describe('orchestrate · 分层失败', () => {
  it('OUTPUT_TRUNCATED: finishReason=length is NOT repaired and reports the real limit', async () => {
    saveCfg();
    const cap = mockSequence([{ content: '{"summary":"截', finish_reason: 'length' }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('OUTPUT_TRUNCATED');
    expect(r.message).toMatch(/4096|上限/);
    // 关键：截断默认**不**触发自动修复
    expect(cap.calls()).toBe(1);
    expect(r.requestCount).toBe(1);
    // 失败绝不写产品结果
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('OUTPUT_EMPTY: HTTP 200 with blank content', async () => {
    saveCfg();
    mockSequence([{ content: '   ' }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('OUTPUT_EMPTY');
      expect(r.message).not.toBe('AI 失败');
    }
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('OUTPUT_INVALID_JSON: truncated JSON without finishReason=length gets repaired once', async () => {
    saveCfg();
    // 第一次非法 JSON，第二次修复成功
    const cap = mockByPhase({ content: '{"summary": "未闭合' }, { content: JSON.stringify(GOOD) });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repaired).toBe(true);
    expect(cap.calls()).toBe(2);
  });

  it('OUTPUT_INVALID_JSON stays failed when repair also fails', async () => {
    saveCfg();
    const cap = mockByPhase({ content: 'not json at all' }, { content: 'still not json' });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('OUTPUT_INVALID_JSON');
    // 上限 2 次请求，绝不循环
    expect(cap.calls()).toBe(2);
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('OUTPUT_SCHEMA_INVALID: JSON valid but wrong shape, repair cannot fix it', async () => {
    saveCfg();
    const cap = mockByPhase(
      { content: JSON.stringify({ summary: 123, facts: 'not-array' }) },
      { content: JSON.stringify({ summary: 456, facts: 'still-wrong' }) },
    );
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('OUTPUT_SCHEMA_INVALID');
      expect(r.detail).toBeTruthy();
    }
    expect(cap.calls()).toBe(2);
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('OUTPUT_REFUSAL: content_filter / refusal is reported as refusal', async () => {
    saveCfg();
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'content_filter', message: { content: '', refusal: 'cannot comply' } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('OUTPUT_REFUSAL');
      expect(r.retryable).toBe(false);
    }
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  // V3.0.1 · P0-4：请求层失败被**分类**，不再一律 REQUEST_FAILED。
  // 这里同时覆盖 AI-ERROR-001（413 → REQUEST_CONTEXT_TOO_LARGE）
  // 与 AI-ERROR-002（429 → REQUEST_RATE_LIMITED）。
  it('REQUEST_HTTP_ERROR: HTTP 401 is classified with the real status code', async () => {
    saveCfg();
    mockSequence([{ content: '', status: 401 }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_HTTP_ERROR');
      expect(r.retryable).toBe(false); // 401 认证失败不可重试
      expect(r.detail).toMatch(/401/);
    }
  });

  it('AI-ERROR-001: HTTP 413 (context too large) → REQUEST_CONTEXT_TOO_LARGE', async () => {
    saveCfg();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('request entity too large: maximum context length exceeded', { status: 413 }),
    ) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_CONTEXT_TOO_LARGE');
      expect(r.retryable).toBe(false); // 必须减少样本，重试无意义
      expect(r.message).toMatch(/输入内容过大/);
      expect(r.detail).toBeTruthy();
    }
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('AI-ERROR-002: HTTP 429 → REQUEST_RATE_LIMITED', async () => {
    saveCfg();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limit exceeded', { status: 429 })) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_RATE_LIMITED');
      expect(r.retryable).toBe(true);
      expect(r.message).toMatch(/限流/);
    }
    expect(await db.commentAnalyses.count()).toBe(0);
  });

  it('AI-TIMEOUT-001: AbortError (timeout) → REQUEST_TIMEOUT, not REQUEST_FAILED', async () => {
    saveCfg();
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abort) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_TIMEOUT');
      expect(r.retryable).toBe(true);
      expect(r.message).toMatch(/超时/);
      expect(r.detail).toBeTruthy(); // 禁止「技术细节：空」
    }
  });

  it('REQUEST_NETWORK_ERROR: DNS/CORS failure is classified as a network error', async () => {
    saveCfg();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_NETWORK_ERROR');
      expect(r.detail).toMatch(/Failed to fetch/);
    }
  });

  it('REQUEST_PROVIDER_ERROR: unknown model is reported as a provider error', async () => {
    saveCfg();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: 'The model `gpt-nope` does not exist' } }),
      text: async () => '',
    }) as unknown as typeof fetch;
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_PROVIDER_ERROR');
      expect(r.message).toMatch(/Model 不存在/);
    }
  });

  it('NO_PROVIDER: refuses to borrow another provider config', async () => {
    localStorage.clear();
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('NO_PROVIDER');
  });

  it('never exceeds 2 AI requests even when both attempts fail', async () => {
    saveCfg();
    const cap = mockByPhase({ content: 'bad' }, { content: 'bad2' });
    await orchestrate(BASE_OPTS);
    expect(cap.calls()).toBeLessThanOrEqual(2);
  });
});

describe('orchestrate · Provider 不错配', () => {
  it('routes to the explicitly requested provider endpoint AND credentials', async () => {
    saveCfg('openai-compatible');
    const cap = mockSequence([{ content: JSON.stringify(GOOD) }]);
    const r = await orchestrate({ ...BASE_OPTS, provider: 'deepseek' });
    expect(cap.urls()[0]).toContain('deepseek.example');
    expect(cap.headers()[0]!.Authorization).toBe('Bearer sk-deepseek');
    if (r.ok) {
      expect(r.usedConfig.name).toBe('deepseek');
      expect(r.usedConfig.model).toBe('deepseek-chat');
    }
  });

  it('fails loudly when the requested provider is not configured', async () => {
    saveCfg('openai-compatible');
    const r = await orchestrate({ ...BASE_OPTS, provider: 'gemini' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('NO_PROVIDER');
  });
});

describe('引用可验证性（V3.1 匿名 ref / V3.2 全研究字段扫描）', () => {
  it('auditCitations flags refs that do not exist in the sample', () => {
    const withFake: CommentAIResult = {
      ...GOOD,
      claims: [{ statement: '有人这么说', refs: ['C001', 'C404'], confidence: 'medium' }],
      mechanisms: [
        ...GOOD.mechanisms,
        { hypothesis: '无引用的机制猜测', explanation: '缺证据', evidenceRefs: [], confidence: 'low' },
      ],
    };
    const a = auditCitations(withFake, ['C001', 'C002']);
    expect(a.unknownRefs).toEqual(['C404']);
    expect(a.claimsWithoutCitation).toBe(1);
    // GOOD 8 条引用 + 新 claims 多出的 1 条 = 9
    expect(a.totalCitations).toBe(9);
  });

  it('auditCitations counts every citation and every uncited claim', () => {
    const a = auditCitations(GOOD, ['C001', 'C002']);
    expect(a.unknownRefs).toEqual([]);
    expect(a.claimsWithoutCitation).toBe(0);
    // narratives 1 + tensions 2 + mechanisms 1 + signalVsNoise 1
    // + contentImplications 1 + claims 1 + hypothesesToTest 1 = 8
    expect(a.totalCitations).toBe(8);
  });
});

describe('mapToCommentAnalysis（领域投影 + V3.1 匿名引用回溯）', () => {
  it('maps the AI structure into the product record, traces refs back to real rpids, and stores citationMap', () => {
    const rec = mapToCommentAnalysis(GOOD, {
      videoId: 'v1',
      model: 'm',
      citationMap: { C001: '101', C002: '102' },
      auditId: 'ai_audit_1',
    });
    expect(rec.videoId).toBe('v1');
    expect(rec.model).toBe('m');
    // V3.2.0 · AI-META：auditId 随产品结果落库
    expect(rec.auditId).toBe('ai_audit_1');
    // 核心矛盾投影到 supportResult（渲染文本经映射回真实 rpid，本地口径）
    expect(rec.supportResult[0]).toContain('101');
    expect(rec.supportResult[0]).toContain('102');
    expect(rec.oppositionResult).toEqual([]);
    // 引用回溯覆盖全部研究字段（narratives/tensions/mechanisms/signal/implications/claims/hypotheses）
    expect(rec.citedCommentRpids.sort()).toEqual(['101', '102']);
    expect(rec.themeResult[0]).toContain('画质认可');
    expect(rec.themeResult[0]).toContain('主叙事');
    // V3.1.0：citationMap 必须随产品结果落库
    expect(rec.citationMap).toEqual({ C001: '101', C002: '102' });
    // 情绪未由结构化输出提供 → 明确写进 uncertainty，而不是假装是 0 情绪
    expect(rec.uncertaintyNote).toMatch(/未由结构化输出提供/);
  });

  it('falls back to the raw ref when no citationMap is provided (legacy-safe)', () => {
    const rec = mapToCommentAnalysis(GOOD, { videoId: 'v1', model: 'm' });
    expect(rec.supportResult[0]).toContain('C001');
    expect(rec.citedCommentRpids).toEqual([]);
    expect(rec.citationMap).toEqual({});
  });
});

describe('getProviderConfig（V3.0 新增）', () => {
  it('reads the requested provider config, not the active one', async () => {
    saveCfg('openai-compatible');
    const ds = await getProviderConfig('deepseek');
    expect(ds?.baseUrl).toBe('https://deepseek.example/v1');
    expect(ds?.model).toBe('deepseek-chat');
  });

  it('corriges a name mismatch in stored config', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: { deepseek: { name: 'openai-compatible', baseUrl: 'x', apiKey: 'k', model: 'm' } },
      }),
    );
    const ds = await getProviderConfig('deepseek');
    expect(ds?.name).toBe('deepseek');
  });

  it('returns null for unconfigured provider', async () => {
    saveCfg('openai-compatible');
    expect(await getProviderConfig('custom')).toBeNull();
  });
});
