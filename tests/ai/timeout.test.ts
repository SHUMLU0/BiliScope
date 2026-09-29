/**
 * V3.1.0 · P0-AI 时长放宽 — TIMEOUT-002 / TIMEOUT-003 行为测试。
 *
 * 规格（任务书第 2 节）：
 *  - 流式 idle timeout 选项 60/120/180/300/**不限制**，默认 300s（TIMEOUT-001 常量断言见 streaming.test.ts）；
 *  - AI Test Mode = **不限制**（orchestrator 归一为 null，不依赖 UI 传参）；
 *  - **不得删除 AbortController**：`idleTimeoutMs === null` 只是不建 idle timer，
 *    真实断连 / 用户取消（外部 signal）仍必须让请求失败。
 *
 * 时间预算：watchdog tick = 1000ms（openai-adapter 实现），因此「timer 生效」场景
 * 约在 1.0~1.2s 处触发 abort；单测最长 ~1.6s，全部真实 timer（不用 fake timers，
 * 避免 Date.now / performance.now 与 timer 推进不同步的假绿）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '@ai/openai-adapter';
import { clearAll } from '@db/database';
import { orchestrate } from '@ai/orchestrator';
import type { CommentAIResult } from '@ai/schemas';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const cfg = {
  name: 'openai-compatible' as const,
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  supportsStreaming: true,
};

/** 把正文片段包成 OpenAI 兼容流式 chunk 负载 */
function oaDelta(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-timeout',
    model: 'gpt-test',
    choices: [{ delta: { content }, finish_reason: null }],
    ...extra,
  });
}

interface ScheduleStep {
  /** 距上一个事件（而非距开头）的毫秒数 */
  delayMs: number;
  payload?: string;
  close?: boolean;
}

/**
 * 按时间表吐 SSE 的 fetch mock。关键：**监听 request signal** ——
 * abort 时 controller.error()，等价真实浏览器「连接中断 → reader.read() 抛 AbortError」。
 * 这条链路是「断连仍必须失败」红线在测试里的落点。
 */
function sseTimedFetch(schedule: ScheduleStep[]): void {
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        const onAbort = (): void => {
          try {
            controller.error(new Error('The operation was aborted'));
          } catch {
            /* 已 error / closed */
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        let at = 0;
        for (const step of schedule) {
          at += step.delayMs;
          const fire = (): void => {
            if (signal?.aborted) return;
            try {
              if (step.payload !== undefined) {
                controller.enqueue(encoder.encode(`data: ${step.payload}\n\n`));
              }
              if (step.close) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              }
            } catch {
              /* controller 已关闭 */
            }
          };
          setTimeout(fire, at);
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

describe('TIMEOUT-002 · idleTimeoutMs 语义（流式）', () => {
  it(
    'number 生效：空闲超过指定上限 → watchdog 终止请求（不允许「不限制」幻觉）',
    async () => {
      // chunk1 立即到达，此后**挂起**（永不 close）→ idle 从 chunk1 起算；
      // watchdog 1000ms tick：idleMs=1000 >= 150 → timedOut + ctrl.abort()
      // → mock 流响应 signal error → read() 抛错 → analyze rejects。
      sseTimedFetch([{ delayMs: 0, payload: oaDelta('{"summary":"') }]);
      const a = new OpenAICompatibleAdapter(cfg);
      await expect(
        a.analyze({ systemPrompt: 's', userPrompt: 'u', idleTimeoutMs: 150 }),
      ).rejects.toThrow(/abort/i);
    },
    { timeout: 15_000 },
  );

  it(
    'null = 不限制：超过任何默认上限的长静默后数据到达 → 请求继续并成功完成',
    async () => {
      // chunk1 → 1400ms 静默 → chunk2 + close。
      // 若 idle timer 存在（哪怕是默认 300s 之外的任何 number），1400ms 静默期间
      // watchdog tick（1s）早已 abort；null 下请求活到 chunk2 → resolve。
      sseTimedFetch([
        { delayMs: 0, payload: oaDelta('{"summary":"') },
        { delayMs: 1400, payload: oaDelta('长输出"}'), close: true },
      ]);
      const a = new OpenAICompatibleAdapter(cfg);
      const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', idleTimeoutMs: null });
      expect(r.text).toBe('{"summary":"长输出"}');
    },
    { timeout: 15_000 },
  );

  it(
    'null 保留 AbortController：外部中止（用户取消 / 真实断连）仍必须失败',
    async () => {
      // 流永不发数据、永不 close（模拟彻底挂死）；idleTimeoutMs=null（无 idle timer）；
      // 外部 signal 200ms 后 abort → mock 流 error → read() 抛错 → rejects。
      // ⚠️ 红线：null ≠ 删除中止能力。
      sseTimedFetch([]);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      const a = new OpenAICompatibleAdapter(cfg);
      await expect(
        a.analyze({ systemPrompt: 's', userPrompt: 'u', idleTimeoutMs: null, signal: ctrl.signal }),
      ).rejects.toThrow(/abort/i);
    },
    { timeout: 15_000 },
  );
});

describe('TIMEOUT-003 · AI Test Mode = 不限制（orchestrator 归一）', () => {
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
            supportsStreaming: true,
          },
        },
      }),
    );
  }

  const GOOD: CommentAIResult = {
    summary: '评论区以正面为主',
    facts: ['样本 1 条'],
    findings: [{ type: 'theme', statement: '画质被讨论', evidenceRefs: ['C001'] }],
    themes: [{ name: '画质', refs: ['C001'] }],
    support: [{ statement: '认可画质', refs: ['C001'] }],
    opposition: [],
    needs: [],
    questions: [],
    uncertainty: [],
    nextResearch: [],
  };
  const goodJson = JSON.stringify(GOOD);

  const BASE = {
    domain: 'comment' as const,
    targetId: 'BV1timeout',
    systemPrompt: 'sys',
    userPrompt: `user ${'x'.repeat(50)}`,
    knownRefs: ['C001'],
    citationMap: { C001: '100' },
    stream: true,
    requestStrategy: 'single' as const,
    factsJson: JSON.stringify({}),
  };

  beforeEach(async () => {
    saveCfg();
    await clearAll();
  });

  it(
    'testMode=true 时显式 idleTimeoutMs 被归一为 null：长静默流仍成功（不依赖 UI 传参）',
    async () => {
      // 显式传入 120ms —— 若归一失败（照传 number），watchdog 1s tick 即 abort；
      // 归一生效（null）→ 1400ms 静默后 chunk2 到达 → 成功。
      const [head, tail] = [goodJson.slice(0, Math.ceil(goodJson.length / 2)), goodJson.slice(Math.ceil(goodJson.length / 2))];
      sseTimedFetch([
        { delayMs: 0, payload: oaDelta(head) },
        { delayMs: 1400, payload: oaDelta(tail), close: true },
      ]);
      const r = await orchestrate({
        ...BASE,
        testMode: true,
        idleTimeoutMs: 120,
      });
      expect(r.ok).toBe(true);
    },
    { timeout: 15_000 },
  );

  it(
    '非 Test Mode 对照：同一显式 idleTimeoutMs=120 正常生效（长静默 → 失败）',
    async () => {
      sseTimedFetch([{ delayMs: 0, payload: oaDelta('{"summary":"') }]);
      const r = await orchestrate({
        ...BASE,
        idleTimeoutMs: 120,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // 空闲中止被如实分类为请求类失败（REQUEST_TIMEOUT / REQUEST_ABORTED 等），而不是别的
        expect(r.status).toMatch(/^REQUEST_/);
      }
    },
    { timeout: 15_000 },
  );
});
