/**
 * V3.1.1 · P0：暂停分析 / 继续分析（PAUSE-001..005）。
 *
 * 规格（任务书 §六/§七）：
 *  - 「暂停分析」：Abort Main + Probe → 状态 REQUEST_PAUSED → 保留 input snapshot →
 *    不写 CommentAnalysis → 不把半截 JSON 当成功、不留半截审计行；
 *  - 「继续分析」：复用**完全相同**的 input snapshot 重发 Main ——
 *    不重新采集评论、不重排 sample、不偷改 sample / prompt / maxTokens / schema；
 *  - 复用同一快照 → 两次运行的 requestFingerprint 一致；
 *  - abort() 不带 reason 仍是「取消」（REQUEST_FAILED / user-cancelled），绝不与暂停混淆。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, db } from '@db/database';
import { orchestrate } from '@ai/orchestrator';
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

/**
 * 暂停感知 mock：probe 固定快速 OK；main 行为由 `state.mainMode` 控制 ——
 * 'hang' = 永不响应（等用户暂停/取消 abort）；'ok' = 20ms 后返回 GOOD。
 */
function makePauseAwareMock(): {
  aborted: { probe: boolean; main: boolean };
  state: { mainMode: 'hang' | 'ok' };
} {
  const aborted = { probe: false, main: false };
  const state = { mainMode: 'hang' } as { mainMode: 'hang' | 'ok' };

  globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
      max_tokens?: number;
    };
    const isProbe =
      body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
    const kind: 'probe' | 'main' = isProbe ? 'probe' : 'main';
    const signal = init?.signal;

    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        if (kind === 'probe') aborted.probe = true;
        else aborted.main = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      if (kind === 'probe') {
        // 探针故意慢（5000ms）：保证「暂停时刻」探针仍在途，中止传播才能被观测到
        // （若探针早已完成，sendOnce 的 unlink 会摘除监听 —— 生产行为正确，只是无从观测）
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({
                  choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            ),
          5000,
        );
        return;
      }

      if (state.mainMode === 'hang') return; // 永不 resolve（等暂停/取消）
      setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: GOOD_JSON } }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          ),
        20,
      );
    });
  }) as unknown as typeof fetch;

  return { aborted, state };
}

/**
 * 冻结的输入快照（模拟 UI 层保留的 snapshot）：暂停后「继续分析」复用**同一个对象**重发。
 * signal 不属于快照 —— 每次运行注入新的 AbortSignal。
 */
function makeSnapshot(): Omit<Parameters<typeof orchestrate>[0], 'signal'> {
  return {
    domain: 'comment' as const,
    targetId: 'v_pause',
    systemPrompt: 'sys-pause',
    userPrompt: 'user-pause',
    knownRefs: ['C001', 'C002'],
    citationMap: { C001: '101', C002: '102' },
    maxTokens: 4096,
    idleTimeoutMs: 120_000,
    requestStrategy: 'probe_guarded' as const,
  };
}

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

describe('V3.1.1 · 暂停/继续（PAUSE-001..005）', () => {
  it('PAUSE-001: 暂停 → REQUEST_PAUSED；Main+Probe 被终止；零落库（无产品结果、无半截审计行）', async () => {
    saveCfg();
    const { aborted } = makePauseAwareMock();
    const ctrl = new AbortController();
    const p = orchestrate({ ...makeSnapshot(), signal: ctrl.signal });
    await new Promise((res) => setTimeout(res, 30));
    ctrl.abort('pause');
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('REQUEST_PAUSED');
    expect(r.detail).toBe('user-paused');
    expect(r.message).toContain('已暂停');
    // 暂停信号确实终止了双方
    expect(aborted.main).toBe(true);
    expect(aborted.probe).toBe(true);
    // 不写产品结果、不留半截审计行（main 被中止 → aiAnalyze 未落库；probe 主动取消不留行）
    expect(await db.commentAnalyses.toArray()).toHaveLength(0);
    expect(await db.aiAnalyses.toArray()).toHaveLength(0);
  });

  it('PAUSE-002: 继续分析复用同一输入快照重发 Main → 成功且产品结果落库', async () => {
    saveCfg();
    const { state } = makePauseAwareMock();
    const snap = makeSnapshot();

    // 第一次：暂停
    const ctrl1 = new AbortController();
    const p1 = orchestrate({ ...snap, signal: ctrl1.signal });
    await new Promise((res) => setTimeout(res, 30));
    ctrl1.abort('pause');
    const paused = await p1;
    expect(paused.ok).toBe(false);
    if (paused.ok) return;
    expect(paused.status).toBe('REQUEST_PAUSED');

    // 「继续分析」：同一个快照对象 + 新 signal
    state.mainMode = 'ok';
    const ctrl2 = new AbortController();
    const r2 = await orchestrate({ ...snap, signal: ctrl2.signal });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.status).toBe('SUCCESS');
    expect(await db.commentAnalyses.toArray()).toHaveLength(1);
  });

  it('PAUSE-003: 暂停与继续两次运行的 requestFingerprint 一致（快照未被偷改）', async () => {
    saveCfg();
    const { state } = makePauseAwareMock();
    const snap = makeSnapshot();

    const ctrl1 = new AbortController();
    const p1 = orchestrate({ ...snap, signal: ctrl1.signal });
    await new Promise((res) => setTimeout(res, 30));
    ctrl1.abort('pause');
    const paused = await p1;
    expect(paused.ok).toBe(false);

    state.mainMode = 'ok';
    const ctrl2 = new AbortController();
    const r2 = await orchestrate({ ...snap, signal: ctrl2.signal });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // ★ 指纹一致 = 输入快照完全相同（sample/prompt/maxTokens/时长都未被改动）
    expect(paused.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(paused.requestFingerprint).toBe(r2.requestFingerprint);
  });

  it('PAUSE-004: abort() 不带 reason → 仍是「取消」（REQUEST_FAILED / user-cancelled），不与暂停混淆', async () => {
    saveCfg();
    makePauseAwareMock();
    const ctrl = new AbortController();
    const p = orchestrate({ ...makeSnapshot(), signal: ctrl.signal });
    await new Promise((res) => setTimeout(res, 30));
    ctrl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('REQUEST_FAILED');
    expect(r.status).not.toBe('REQUEST_PAUSED');
    expect(r.detail).toBe('user-cancelled');
    expect(r.message).toContain('已取消');
  });

  it('PAUSE-005: 暂停信号同时终止 Probe，且探针（主动取消）不留审计行', async () => {
    saveCfg();
    const { aborted } = makePauseAwareMock();
    const ctrl = new AbortController();
    const p = orchestrate({ ...makeSnapshot(), signal: ctrl.signal });
    await new Promise((res) => setTimeout(res, 30));
    ctrl.abort('pause');
    await p;
    expect(aborted.probe).toBe(true);
    const audits = await db.aiAnalyses.toArray();
    expect(audits.filter((a) => a.requestType === 'probe')).toHaveLength(0);
  });
});
