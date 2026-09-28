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
import { orchestrate, auditCitations, mapToCommentAnalysis, TASK_DEFAULT_MAX_TOKENS } from '@ai/orchestrator';
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
  facts: ['样本 3 条'],
  findings: [{ type: 'theme', statement: '画质被讨论', evidenceRpids: ['101'] }],
  themes: [{ name: '画质', rpids: ['101'] }],
  support: [{ statement: '认可画质', rpid: ['101'] }],
  opposition: [{ statement: '更新慢', rpid: ['102'] }],
  needs: ['提高更新频率'],
  questions: ['下期何时出'],
  uncertainty: ['样本量小'],
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
  knownRpids: ['101', '102', '103'],
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

  it('honours the comment-domain token default (>=4096, not 1024)', async () => {
    saveCfg();
    const cap = mockSequence([{ content: JSON.stringify(GOOD) }]);
    await orchestrate(BASE_OPTS);
    expect(cap.calls()).toBe(1);
    expect(TASK_DEFAULT_MAX_TOKENS.comment).toBeGreaterThanOrEqual(4096);
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

  it('REQUEST_FAILED: HTTP 401', async () => {
    saveCfg();
    mockSequence([{ content: '', status: 401 }]);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('REQUEST_FAILED');
      expect(r.retryable).toBe(true);
      expect(r.detail).toMatch(/401/);
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

describe('引用可验证性', () => {
  it('auditCitations flags rpids that do not exist in the sample', () => {
    const withFake: CommentAIResult = {
      ...GOOD,
      support: [{ statement: '有人这么说', rpid: ['101', 'rp_does_not_exist'] }],
      opposition: [{ statement: '无引用的论断', rpid: [] }],
    };
    const a = auditCitations(withFake, ['101', '102']);
    expect(a.unknownRpids).toEqual(['rp_does_not_exist']);
    expect(a.claimsWithoutCitation).toBe(1);
    // support 2 + opposition 0 + themes 1 + findings 1 = 4
    expect(a.totalCitations).toBe(4);
  });

  it('auditCitations counts every citation and every uncited claim', () => {
    const a = auditCitations(GOOD, ['101', '102']);
    expect(a.unknownRpids).toEqual([]);
    expect(a.claimsWithoutCitation).toBe(0);
    // support 1 + opposition 1 + themes 1 + findings 1 = 4
    expect(a.totalCitations).toBe(4);
  });
});

describe('mapToCommentAnalysis（领域投影）', () => {
  it('maps the AI structure into the product record and keeps citations', () => {
    const rec = mapToCommentAnalysis(GOOD, { videoId: 'v1', model: 'm' });
    expect(rec.videoId).toBe('v1');
    expect(rec.model).toBe('m');
    expect(rec.supportResult[0]).toContain('101');
    expect(rec.oppositionResult[0]).toContain('102');
    expect(rec.citedCommentRpids.sort()).toEqual(['101', '102']);
    expect(rec.themeResult[0]).toContain('画质');
    // 情绪未由结构化输出提供 → 明确写进 uncertainty，而不是假装是 0 情绪
    expect(rec.uncertaintyNote).toMatch(/未由结构化输出提供/);
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
