/**
 * V3.1.1 · Probe 旁路诊断专项测试（PROBE-001..008）+ Auto 截断语义（AI-LIMIT-004）。
 *
 * 规格（V3.1.1 任务书）核心断言：
 *  - Probe（极轻，不分析评论）与 Main **并行**启动（禁止串行）
 *  - Probe 观察窗（30s，测试注入更短）超时 → **只结束 Probe 自己**（status='timeout'），Main 继续
 *  - Probe 的任何失败（HTTP 401 / 空响应 / 网络）都**绝不** abort Main、**绝不**改写 Main 成败
 *    → `Probe FAIL + Main SUCCESS = AI 分析成功（探针存在警告）` 是合法状态
 *  - 探针空响应 = warning（transportConnected=true + modelResponded=false），**不是** OUTPUT_EMPTY
 *  - Main 成功正常落库；Probe 审计行 requestType='probe' 独立分区；主动取消不留行
 *  - 用户取消 → 同时终止 Probe 与 Main，如实报告「已取消」（绝不伪装成超时）
 *  - 仅真实 MAX_TOKENS finishReason 才是 OUTPUT_TRUNCATED；Auto 模式文案不提示 BiliScope timeout
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
  facts: ['样本 3 条'],
  findings: [{ type: 'theme', statement: '画质被讨论', evidenceRefs: ['C001'] }],
  themes: [{ name: '画质', refs: ['C001'] }],
  support: [{ statement: '认可画质', refs: ['C001'] }],
  opposition: [{ statement: '更新慢', refs: ['C002'] }],
  needs: ['提高更新频率'],
  questions: ['下期何时出'],
  uncertainty: ['样本量小'],
  nextResearch: ['补充二级回复'],
};

const GOOD_JSON = JSON.stringify(GOOD);

const BASE_OPTS = {
  domain: 'comment' as const,
  targetId: 'v_probe',
  systemPrompt: 'sys',
  userPrompt: 'user',
  knownRefs: ['C001', 'C002', 'C003'],
  citationMap: { C001: '101', C002: '102', C003: '103' },
};

interface ProbeMockOpts {
  /** probe 请求行为：正常 OK / HTTP 401 / 永不响应 / 200 空文本 */
  probe: 'ok' | 'reject401' | 'hang' | 'empty';
  /** probe 响应延迟（ms） */
  probeDelayMs?: number;
  /** main 响应体（缺省 = GOOD JSON） */
  mainContent?: string;
  /** main finish_reason（缺省 stop） */
  mainFinish?: string;
  /** main 响应延迟（ms）；hang 时忽略 */
  mainDelayMs?: number;
  /** main 请求永不响应（等待 abort） */
  mainHang?: boolean;
}

/**
 * probe_guarded 感知 mock：按请求体识别 probe（max_tokens=32 + content 'probe'）与 main，
 * 记录两类请求的发起时间（并行性断言用），并对两类请求支持 abort 传播。
 */
function makeProbeAwareMock(o: ProbeMockOpts): {
  events: Array<{ kind: 'probe' | 'main'; t: number }>;
  aborted: { probe: boolean; main: boolean };
} {
  const events: Array<{ kind: 'probe' | 'main'; t: number }> = [];
  const aborted = { probe: false, main: false };

  const openAiResponse = (content: string, finish: string, usage: [number, number, number]): Response =>
    new Response(
      JSON.stringify({
        id: 'chatcmpl-x',
        model: 'gpt-x',
        choices: [{ finish_reason: finish, message: { content } }],
        usage: { prompt_tokens: usage[0], completion_tokens: usage[1], total_tokens: usage[2] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
      max_tokens?: number;
    };
    const isProbe =
      body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
    const kind: 'probe' | 'main' = isProbe ? 'probe' : 'main';
    events.push({ kind, t: Date.now() });
    const signal = init?.signal;

    return new Promise<Response>((resolve, reject) => {
      // abort 传播：外部中止必须能杀死挂起的 fetch（真实网络行为）
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
        if (o.probe === 'hang') return; // 永不 resolve（等观察窗 abort）
        const delay = o.probeDelayMs ?? 0;
        setTimeout(() => {
          if (o.probe === 'reject401') {
            reject(new Error('HTTP 401 Unauthorized（认证失败）'));
          } else if (o.probe === 'empty') {
            resolve(openAiResponse('', 'stop', [1, 0, 1]));
          } else {
            resolve(openAiResponse('OK', 'stop', [1, 1, 2]));
          }
        }, delay);
        return;
      }

      // main
      if (o.mainHang) return; // 永不 resolve（等用户暂停/取消 abort）
      const delay = o.mainDelayMs ?? 0;
      setTimeout(() => {
        resolve(openAiResponse(o.mainContent ?? GOOD_JSON, o.mainFinish ?? 'stop', [10, 20, 30]));
      }, delay);
    });
  }) as unknown as typeof fetch;

  return { events, aborted };
}

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

describe('V3.1.1 · Probe 旁路诊断（PROBE-001..008）', () => {
  it('PROBE-001: Probe 与 Main 并行启动（Main 不等 Probe 完成）', async () => {
    saveCfg();
    const { events, aborted } = makeProbeAwareMock({ probe: 'ok', probeDelayMs: 150, mainDelayMs: 30 });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('SUCCESS');
    // 两类请求都到达
    expect(events.some((e) => e.kind === 'probe')).toBe(true);
    expect(events.some((e) => e.kind === 'main')).toBe(true);
    // 并行：Main 的发起时间与 Probe 相差 < 100ms（若串行，Main 会等到 Probe 完成 +150ms）
    const probeT = events.find((e) => e.kind === 'probe')!.t;
    const mainT = events.find((e) => e.kind === 'main')!.t;
    expect(Math.abs(mainT - probeT)).toBeLessThan(100);
    // Main 本身绝不被任何人为计时器中止
    expect(aborted.main).toBe(false);
  });

  it('PROBE-002: 观察窗超时只杀 Probe 自己（status=timeout），Main 继续并成功', async () => {
    saveCfg();
    // probe 挂死 → 50ms 观察窗到期终止 Probe；main 250ms 后正常返回 → 必须 SUCCESS
    const { aborted } = makeProbeAwareMock({ probe: 'hang', mainDelayMs: 250 });
    const r = await orchestrate({ ...BASE_OPTS, probeTimeoutMs: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('SUCCESS');
    // 探针被观察窗终止（诊断如实记录），但 Main 活到了最后
    expect(aborted.probe).toBe(true);
    expect(aborted.main).toBe(false);
    expect(r.probe?.status).toBe('timeout');
    expect(r.probe?.transportConnected).toBe(false);
    // 诊断状态独立：绝不因此改写 Main 成败（V3.0.2 的 REQUEST_PROBE_TIMEOUT 已删除）
    expect(r.status).not.toBe('REQUEST_PROBE_TIMEOUT');
  });

  it('PROBE-003: Probe healthy → Main 跑再久也不受任何人为总时长限制', async () => {
    saveCfg();
    // 观察窗 50ms 早已到期；Main 故意跑 400ms（等比放大 30/60/120s 场景）→ 仍必须 SUCCESS
    const { events } = makeProbeAwareMock({ probe: 'ok', probeDelayMs: 10, mainDelayMs: 400 });
    const t0 = Date.now();
    const r = await orchestrate({ ...BASE_OPTS, probeTimeoutMs: 50 });
    const wall = Date.now() - t0;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('SUCCESS');
    expect(wall).toBeGreaterThanOrEqual(400);
    expect(events.some((e) => e.kind === 'main')).toBe(true);
    // Probe 诊断三态：healthy = 连接成功 + 模型有响应
    expect(r.probe?.status).toBe('healthy');
    expect(r.probe?.transportConnected).toBe(true);
    expect(r.probe?.modelResponded).toBe(true);
    expect(typeof r.probe?.latencyMs).toBe('number');
  });

  it('PROBE-004: Probe HTTP 401 → Main 照常成功（探针 failed 只进诊断与审计）', async () => {
    saveCfg();
    // probe 10ms 即 401，main 100ms 返回 —— 旧语义下这里会是整体失败，V3.1.1 必须 SUCCESS
    const { aborted } = makeProbeAwareMock({ probe: 'reject401', probeDelayMs: 10, mainDelayMs: 100 });
    const r = await orchestrate({ ...BASE_OPTS, probeTimeoutMs: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★ 核心反转断言：Probe FAIL + Main SUCCESS = AI 分析成功
    expect(r.status).toBe('SUCCESS');
    expect(r.domainRecordId).toBeTruthy();
    expect(await db.commentAnalyses.toArray()).toHaveLength(1);
    // 探针诊断如实记录失败原因
    expect(r.probe?.status).toBe('failed');
    expect(r.probe?.transportConnected).toBe(false);
    expect(r.probe?.error).toContain('401');
    // 探针失败绝没有波及 Main
    expect(aborted.main).toBe(false);
    // 探针失败留独立审计行（probe_failed），分析行独立存在
    const audits = await db.aiAnalyses.toArray();
    const probeRows = audits.filter((a) => a.requestType === 'probe');
    expect(probeRows).toHaveLength(1);
    const probeMeta = ((probeRows[0]!.parsedResult as Record<string, unknown>).__meta ?? {}) as Record<
      string,
      unknown
    >;
    expect(probeMeta.status).toBe('probe_failed');
  });

  it('PROBE-005: Probe 空响应 → warning（连接成功但模型没说话），绝不是 OUTPUT_EMPTY', async () => {
    saveCfg();
    makeProbeAwareMock({ probe: 'empty', probeDelayMs: 10, mainDelayMs: 50 });
    const r = await orchestrate({ ...BASE_OPTS, probeTimeoutMs: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★ 空响应 = 诊断警告，不是分析失败（真正的 OUTPUT_EMPTY 只允许 Main 判定）
    expect(r.status).toBe('SUCCESS');
    expect(r.probe?.status).toBe('warning');
    expect(r.probe?.transportConnected).toBe(true);
    expect(r.probe?.modelResponded).toBe(false);
    expect(r.probe?.error).toBe('probe-response-empty');
  });

  it('PROBE-006: Main 成功正常落库；Probe 审计独立分区且不计入分析 token（三态回写）', async () => {
    saveCfg();
    makeProbeAwareMock({ probe: 'ok', probeDelayMs: 10, mainDelayMs: 10 });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 产品结果正常落库
    expect(r.domainRecordId).toBeTruthy();
    const stored = await db.commentAnalyses.toArray();
    expect(stored).toHaveLength(1);

    // 审计分区：probe 行 + analysis 行
    const audits = await db.aiAnalyses.toArray();
    const probeRows = audits.filter((a) => a.requestType === 'probe');
    const analysisRows = audits.filter((a) => a.requestType !== 'probe');
    expect(probeRows).toHaveLength(1);
    expect(analysisRows).toHaveLength(1);
    // Probe token 独立记录（mock：probe usage total=2；main usage total=30）—— 绝不合并
    expect(probeRows[0]!.tokenUsage?.total).toBe(2);
    expect(analysisRows[0]!.tokenUsage?.total).toBe(30);
    // 成功审计回写携带 Probe 诊断三态（V3.1.1：status/transportConnected/modelResponded）
    const meta = ((analysisRows[0]!.parsedResult as Record<string, unknown>).__meta ?? {}) as Record<
      string,
      unknown
    >;
    const probeMeta = meta.probe as
      | {
          requestType?: string;
          status?: string;
          transportConnected?: boolean;
          modelResponded?: boolean;
        }
      | undefined;
    expect(probeMeta?.requestType).toBe('probe');
    expect(probeMeta?.status).toBe('healthy');
    expect(probeMeta?.transportConnected).toBe(true);
    expect(probeMeta?.modelResponded).toBe(true);
  });

  it('PROBE-007: 用户取消 → 同时终止 Probe 与 Main，如实报告「已取消」，探针不留审计行', async () => {
    saveCfg();
    const { aborted } = makeProbeAwareMock({ probe: 'ok', probeDelayMs: 5000, mainHang: true });
    const ctrl = new AbortController();
    const p = orchestrate({ ...BASE_OPTS, probeTimeoutMs: 60_000, signal: ctrl.signal });
    // 等请求真正发出后取消
    await new Promise((res) => setTimeout(res, 30));
    ctrl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toBe('user-cancelled');
    expect(r.message).toContain('已取消');
    // 绝不伪装成超时 / probe 失败
    expect(r.status).not.toBe('REQUEST_TIMEOUT');
    expect(r.status).not.toBe('REQUEST_PROBE_TIMEOUT');
    expect(aborted.probe).toBe(true);
    expect(aborted.main).toBe(true);
    // 主动取消：探针不留审计行（零落库）
    const audits = await db.aiAnalyses.toArray();
    expect(audits.filter((a) => a.requestType === 'probe')).toHaveLength(0);
  });

  it('PROBE-008: single 策略不发 Probe，结果带 probe=skipped 诊断标记', async () => {
    saveCfg();
    const { events } = makeProbeAwareMock({ probe: 'ok', mainDelayMs: 5 });
    const r = await orchestrate({ ...BASE_OPTS, requestStrategy: 'single' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(events.some((e) => e.kind === 'probe')).toBe(false);
    expect(events.some((e) => e.kind === 'main')).toBe(true);
    expect(r.probe?.status).toBe('skipped');
    expect(r.probe?.transportConnected).toBe(false);
    expect(r.probe?.error).toBe('skipped');
  });

  it('AI-LIMIT-004: 真实 MAX_TOKENS finishReason → OUTPUT_TRUNCATED（Auto 文案，不提示 BiliScope timeout）', async () => {
    saveCfg();
    const truncated = '{"summary":"这是一段被截断的输出","facts":["a"';
    makeProbeAwareMock({ probe: 'ok', probeDelayMs: 5, mainContent: truncated, mainFinish: 'max_tokens' });
    const r = await orchestrate(BASE_OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('OUTPUT_TRUNCATED');
    expect(r.message).toContain('MAX_TOKENS');
    expect(r.message).toContain('Auto');
    // 不再把 Provider 的 MAX_TOKENS 说成 BiliScope 超时
    expect(r.message).not.toContain('超时');
  });
});
