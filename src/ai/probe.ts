/**
 * V3.0.2 · probe_guarded：Provider 探针（Probe）。
 *
 * 语义（任务书 §二/§三/§五）：
 *  - Probe 极轻：不分析评论，只验证「网络可达 / API Key 有效 / 模型开始响应」。
 *  - Probe 与 Main **并行启动**（并行才有意义；串行等于让用户等两次 RTT）。
 *  - Probe 30s 内没有任何有效响应 → 终止 Probe 与 Main → `REQUEST_PROBE_TIMEOUT`。
 *  - Probe 成功 → `probeHealthy = true` → **取消 BiliScope 一切人为总时长限制**
 *    （Main 只由 Provider 正常完成 / 明确错误 / MAX_TOKENS / 真实断连 / 用户取消来结束）。
 *  - Probe **不得污染分析审计**：审计记录携带 `requestType='probe'`，
 *    token 用量单独记录，不计入评论分析成本。
 *
 * ⚠️ 与 V3.0.1 任务书「不发探测请求」的关系：V3.0.2 明确**取代**该条 ——
 * 探测请求现在是本策略的核心组成；被禁止的是「探测失败仍继续发主请求」。
 */

import type { AnalyzeRequest, ProbeResult } from './types';

/** Probe 等待上限：30s 内无有效响应 → 终止 Probe 与 Main */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * 构造探针请求：极轻、非流式、不进 JSON 模式（只要一句 `OK`）。
 * `maxTokens: 32` 是探针自身的（探针不是分析，不适用 Auto 语义 —— 它必须便宜且快）。
 */
export function buildProbeRequest(opts?: { signal?: AbortSignal }): AnalyzeRequest {
  return {
    systemPrompt: 'You are a connectivity probe for BiliScope. Reply with exactly: OK',
    userPrompt: 'probe',
    temperature: 0,
    jsonMode: false,
    maxTokens: 32,
    stream: false,
    requestType: 'probe',
    signal: opts?.signal,
  };
}

/** 判定探针响应是否「有效」：HTTP 200 且拿到非空文本（哪怕是 `OK`）即算 healthy */
export function isHealthyProbeText(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

/** 探针超时的内部标记（orchestrator 据此映射 REQUEST_PROBE_TIMEOUT） */
export const PROBE_TIMEOUT_MARKER = 'probe-timeout';

/**
 * 把外部 AbortSignal 关联到内部 AbortController（外部中止优先）。
 * 返回清理函数（移除监听）；外部 signal 已中止时立即 abort。
 */
export function linkExternalSignal(external: AbortSignal | undefined, ctrl: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    ctrl.abort();
    return () => undefined;
  }
  const onAbort = (): void => ctrl.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/** 空 ProbeResult（探针被跳过时占位） */
export function skippedProbe(): ProbeResult {
  return { ok: false, latencyMs: 0, error: 'skipped' };
}
