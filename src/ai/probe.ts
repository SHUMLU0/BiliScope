/**
 * V3.1.1 · Probe = Provider 旁路诊断器（bypass diagnostician）。
 *
 * 语义（V3.1.1 规格书 §一/§二/§三/§五 —— 对 V3.0.2 probe_guarded 的**降级修正**）：
 *  - Probe 极轻：不分析评论，不携带任何评论数据，只验证「网络可达 / API Key 有效 / 模型开始响应」。
 *  - Probe 与 Main **并行启动**（并行才有意义；串行等于让用户等两次 RTT）。
 *  - Probe **只观察、只诊断、只告诉用户** —— 它：
 *      ✗ 不修改 Main 请求 / prompt / sample / maxTokens / timeout / schema
 *      ✗ 不决定 Main 成败
 *      ✗ 不主动 Abort Main（V3.0.2 的「看门 → 双杀」已废除）
 *      ✗ 不覆盖 Main 的结果
 *  - Probe 30s 观察窗内无响应 → **Probe 自己结束**（status='timeout'），Main 继续。
 *  - HTTP 2xx 即 `transportConnected=true`（**包括空响应**）；
 *    空响应 → `status='warning'`（连接成功但探针没有返回文本）—— 这是**诊断警告**，
 *    不是 OUTPUT_EMPTY，更不是「AI 分析失败」。真正的 OUTPUT_EMPTY 只允许 Main 判定。
 *  - Probe 的任何失败（401/429/500/网络/空/超时）只进入 `probeStatus` 与 UI 诊断。
 *    允许出现且必须正确呈现：`Probe FAIL + Main SUCCESS` = 「AI 分析成功，但 Provider 探针存在警告」。
 *  - Probe **不得污染分析审计**：审计行 `requestType='probe'`，token 单独记录；
 *    Probe 请求体可单独审计（`probe=true` 语义），且**绝不包含**评论正文/评论 ID/用户名/rpid/videoId。
 */

import type { AnalyzeRequest, ProbeResult, ProbeStatus } from './types';

/** Probe 观察窗上限：30s 内无响应 → Probe 自己结束（不波及 Main） */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * 构造探针请求：极轻、非流式、不进 JSON 模式（只要一句 `OK`）。
 * `maxTokens: 32` 是探针自身的（探针不是分析，不适用 Auto 语义 —— 它必须便宜且快）。
 *
 * ⚠️ V3.1.1：本函数返回**完全独立的新对象** —— 禁止任何「`const probe = baseRequest`
 * 然后修改」的别名复用；Probe 与 Main 的请求对象必须互不相干。
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

/** 判定探针响应体是否包含模型文本（哪怕是 `OK`）—— 仅决定 modelResponded / warning */
export function isHealthyProbeText(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

/** 探针超时的内部标记（Probe 自己的观察窗到期；orchestrator 据此置 status='timeout'） */
export const PROBE_TIMEOUT_MARKER = 'probe-timeout';

/**
 * V3.1.1：把一次探针 transport 结果归纳为诊断状态。
 *
 * 优先级：超时 / 错误 → `timeout` / `failed`；
 * HTTP 2xx → `transportConnected=true`，再有模型文本 → `healthy`，否则 → `warning`。
 */
export function summarizeProbeResult(input: {
  timedOut: boolean;
  errorMessage?: string;
  httpStatus?: number;
  text?: string;
  latencyMs: number;
  requestId?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
}): ProbeResult {
  const base = {
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    text: input.text,
    requestId: input.requestId,
    tokenUsage: input.tokenUsage,
  };
  if (input.timedOut) {
    return { ...base, ok: false, status: 'timeout', transportConnected: false, modelResponded: false, error: PROBE_TIMEOUT_MARKER };
  }
  if (input.errorMessage !== undefined) {
    return { ...base, ok: false, status: 'failed', transportConnected: false, modelResponded: false, error: input.errorMessage };
  }
  // transport 成功（2xx）：连接成功 —— 无论有没有文本
  const modelResponded = isHealthyProbeText(input.text);
  return {
    ...base,
    ok: true,
    status: modelResponded ? 'healthy' : 'warning',
    transportConnected: true,
    modelResponded,
    error: modelResponded ? undefined : 'probe-response-empty',
  };
}

/** 用户可见的探针诊断文案（UI 独立状态行；与 Main 的状态**完全分离**） */
export function describeProbeStatus(pr: ProbeResult | undefined): string {
  if (!pr || pr.status === 'pending') return '探针：等待';
  switch (pr.status) {
    case 'healthy':
      return `探针：正常 · ${(pr.latencyMs / 1000).toFixed(1)}s`;
    case 'warning':
      return '探针：连接成功，但探针没有返回文本';
    case 'timeout':
      return `探针：${Math.round(pr.latencyMs / 1000)}s 无响应`;
    case 'failed':
      return `探针：异常 · ${pr.error ?? '未知错误'}`;
    case 'skipped':
      // V3.1.1：Main 先完成时对 Probe 的主动取消也记为 skipped —— 文案如实区分
      return pr.error === 'main-completed' ? '探针：未参与（分析先完成）' : '探针：未启用';
  }
}

/**
 * 把外部 AbortSignal 关联到内部 AbortController（外部中止优先）。
 * 返回清理函数（移除监听）；外部 signal 已中止时立即 abort。
 */
export function linkExternalSignal(external: AbortSignal | undefined, ctrl: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    ctrl.abort(external.reason);
    return () => undefined;
  }
  // V3.1.1：透传 abort reason —— UI 用 reason 区分「暂停」与「取消」，
  // orchestrator 据此走 PAUSED 通道（保留输入快照）或普通取消。
  const onAbort = (): void => ctrl.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/** 空 ProbeResult（探针被跳过时占位；single 策略） */
export function skippedProbe(): ProbeResult {
  return {
    ok: false,
    status: 'skipped',
    transportConnected: false,
    modelResponded: false,
    latencyMs: 0,
    error: 'skipped',
  };
}

/** 探针等待占位（Probe 尚未落定时的 UI/审计状态） */
export function pendingProbe(): ProbeResult {
  return { ok: false, status: 'pending', transportConnected: false, modelResponded: false, latencyMs: 0 };
}

export type { ProbeStatus };
