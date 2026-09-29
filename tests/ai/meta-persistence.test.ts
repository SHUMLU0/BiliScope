/**
 * V3.2.0 · AI-META-001..003：真实 AI 元数据不得被 refresh 清零。
 *
 * 缺陷背景：旧 `loadStoredReport()` 把 durationMs / requestCount 硬编码为 0，
 * 导致「真实成功 180000ms / 2 次请求，refresh 后显示 0ms / 0 次请求」。
 *
 * 修复：`CommentAnalysis.auditId` → `AIAnalysis.id` 审计行关联；
 * orchestrator 成功回写 `__meta.totalDurationMs / requestCount / repaired / citations`。
 * 本文件模拟 UI 的恢复路径（comment-page loadStoredReport 的数据访问层），
 * 断言 refresh（全新从 Dexie 读取）后元数据与首次分析结果一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, db } from '@db/database';
import { orchestrate } from '@ai/orchestrator';
import { aiAnalysisRepo, commentAnalysisRepo } from '@repositories/index';

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
          apiKey: 'sk-meta',
          model: 'gpt-x',
        },
      },
    }),
  );
}

/** 精简合法结果（其余字段由 Zod default 补全；narratives/claims 提供研究信号） */
const GOOD_JSON = JSON.stringify({
  summary: '评论区以正面为主',
  relevantFacts: ['高赞评论集中于画质讨论'],
  narratives: [{ name: '画质认可', description: '高赞把画质视为核心优点', role: 'primary', refs: ['C001'] }],
  claims: [{ statement: '认可画质', refs: ['C001'], confidence: 'medium' }],
});

const BASE_OPTS = {
  domain: 'comment' as const,
  targetId: 'v_meta',
  systemPrompt: 'sys',
  userPrompt: 'user',
  knownRefs: ['C001', 'C002'],
  citationMap: { C001: '101', C002: '102' },
  requestStrategy: 'single' as const,
};

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

/** 带 5ms 延迟的成功响应（确保真实 durationMs 稳定 > 0） */
function mockOkWith(content: string): void {
  globalThis.fetch = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-meta',
        model: 'gpt-x',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

/** 语义 mock：首次请求（temperature=0.2）给 first，修复请求（temperature=0）给 repair */
function mockByPhase(first: string, repair: string): void {
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 5));
    const body = JSON.parse(String(init?.body ?? '{}')) as { temperature?: number };
    const content = body.temperature === 0 ? repair : first;
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-meta',
        model: 'gpt-x',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

/** 模拟 UI loadStoredReport 的元数据恢复路径（V3.2.0 · auditId → AIAnalysis） */
async function restoreMetaLikeUI(): Promise<{
  model: string;
  durationMs: number;
  requestCount: number;
  repaired: boolean;
  hasAuditId: boolean;
} | null> {
  const list = await commentAnalysisRepo.listByVideo('v_meta');
  const latest = list[0];
  if (!latest) return null;
  if (!latest.auditId) return { model: latest.model, durationMs: 0, requestCount: 0, repaired: false, hasAuditId: false };
  const audit = await aiAnalysisRepo.get(latest.auditId);
  if (!audit) return null;
  const parsed = (audit.parsedResult ?? {}) as Record<string, unknown>;
  const m = (parsed.__meta ?? {}) as Record<string, unknown>;
  return {
    model: audit.model,
    durationMs: typeof m.totalDurationMs === 'number' ? m.totalDurationMs : audit.durationMs,
    requestCount: typeof m.requestCount === 'number' ? m.requestCount : 1,
    repaired: m.repaired === true,
    hasAuditId: true,
  };
}

describe('AI-META · 真实元数据 refresh 后不清零（V3.2.0）', () => {
  it('AI-META-001: SUCCESS → refresh（全新从库读取）后 metadata 与首次分析一致', async () => {
    saveCfg();
    mockOkWith(GOOD_JSON);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const restored = await restoreMetaLikeUI();
    expect(restored).not.toBeNull();
    expect(restored!.hasAuditId).toBe(true);
    expect(restored!.model).toBe('gpt-x');
    expect(restored!.durationMs).toBe(r.durationMs);
    expect(restored!.requestCount).toBe(r.requestCount);
    expect(restored!.repaired).toBe(r.repaired);
    // 关键：绝不出现「180000ms / 2 次请求 → 0ms / 0 次请求」
    expect(restored!.durationMs).not.toBe(0);
    expect(restored!.requestCount).not.toBe(0);
  });

  it('AI-META-002: duration > 0 保留（修复前为硬编码 0）', async () => {
    saveCfg();
    mockOkWith(GOOD_JSON);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.durationMs).toBeGreaterThan(0);
    const restored = await restoreMetaLikeUI();
    expect(restored!.durationMs).toBeGreaterThan(0);
    // 审计行自身的单请求耗时也 > 0（真实计时，非占位）
    const audit = await db.aiAnalyses.get((await db.commentAnalyses.toArray())[0]!.auditId!);
    expect(audit!.durationMs).toBeGreaterThan(0);
  });

  it('AI-META-003: requestCount 保留（含一次自动修复 = 2）', async () => {
    saveCfg();
    // 第一次非法 JSON → 修复请求返回合法结果 → repaired=true, requestCount=2
    mockByPhase('{"summary": "未闭合', GOOD_JSON);
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.requestCount).toBe(2);

    const restored = await restoreMetaLikeUI();
    expect(restored!.requestCount).toBe(2);
    expect(restored!.repaired).toBe(true);
    expect(restored!.durationMs).toBe(r.durationMs);
  });
});
