/**
 * AI Service — 业务层门面。
 *
 * V3.0 变更：
 *  - **Provider 选择不再错配**：旧实现 `buildAdapter({ ...cfg, name: opts.provider ?? cfg.name })`
 *    只替换 `adapter.name`，baseUrl/apiKey/model 仍来自 active provider
 *    → 「请求发到 A 端点却标称是 B」。现在用 `resolveProviderConfig()` 按名字取真实配置。
 *  - `AIAnalysis` = **审计记录**（完整 prompt / raw / token / finishReason / parse 状态），
 *    产品结果由 orchestrator 落 `CommentAnalysis`。本文件只负责审计落库。
 */

import { logger } from '@utils/logger';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { aiAnalysisRepo } from '@repositories/index';
import { getActiveConfig, getProviderConfig, loadProvidersAsync } from './settings';
import { OpenAICompatibleAdapter } from './openai-adapter';
import { GeminiAdapter } from './gemini-adapter';
import type {
  AIProvider,
  AnalyzeRequest,
  AnalyzeResponse,
  ProviderConfig,
  ProviderName,
} from './types';
import type { AIAnalysis } from '@models/task';

export function buildAdapter(cfg: ProviderConfig): AIProvider {
  switch (cfg.name) {
    case 'gemini':
      return new GeminiAdapter(cfg);
    case 'openai-compatible':
    case 'deepseek':
    case 'custom':
    default:
      return new OpenAICompatibleAdapter(cfg);
  }
}

/**
 * V3.0 · 第三节：解析本次请求真正要用的 Provider 配置。
 * 显式指定 provider 时读取**该 provider 自己的** baseUrl/apiKey/model；
 * 未指定时读取 active provider。任何「名与端点不符」的组合都会被拒绝。
 */
export async function resolveProviderConfig(explicit?: ProviderName): Promise<ProviderConfig | null> {
  const cfg = explicit ? await getProviderConfig(explicit) : await getActiveConfig();
  if (!cfg) return null;
  // 二次防线：配置对象里的 name 必须与请求目标一致
  if (explicit && cfg.name !== explicit) return null;
  return cfg;
}

export interface ServiceAnalyzeOpts {
  type: AIAnalysis['type'];
  targetId: string;
  provider?: ProviderName;
  request: AnalyzeRequest;
  /**
   * V3.0：额外的审计元数据（finishReason / parse 状态 / 失败码等）。
   * 由 orchestrator 计算后回填，保证 AIAnalysis 是完整审计记录。
   */
  audit?: AIAnalysisAuditPatch;
}

/** V3.0：写进 AIAnalysis 的诊断补充字段 */
export interface AIAnalysisAuditPatch {
  finishReason?: string;
  finishMessage?: string;
  responseId?: string;
  modelVersion?: string;
  structuredOutput?: string;
  usedMaxTokens?: number;
  parseOk?: boolean;
  parseError?: string;
  status?: string;
  incomplete?: boolean;
  refusal?: string;
  /** 本次会话内第几次尝试（1 = 首次，2 = 自动修复） */
  attempt?: number;
  /** 自动修复前后的总请求数 */
  requestCount?: number;
}

export interface ServiceAnalyzeResult {
  analysis: AIAnalysis;
  response: AnalyzeResponse;
  /** V3.0：本次实际使用的 Provider 配置（用于 UI 显示与诊断） */
  usedConfig: ProviderConfig;
}

export async function aiAnalyze(opts: ServiceAnalyzeOpts): Promise<ServiceAnalyzeResult> {
  const cfg = await resolveProviderConfig(opts.provider);
  if (!cfg) {
    throw new Error(
      opts.provider
        ? `Provider "${opts.provider}" 未配置 baseUrl/apiKey/model，无法发起请求（不借用其他 Provider 配置）。`
        : 'No active AI provider configured.',
    );
  }
  const adapter = buildAdapter(cfg);
  const start = performance.now();
  const response = await adapter.analyze(opts.request);
  const durationMs = Math.round(performance.now() - start);

  // 审计补充字段打包进 parsedResult 之外的一个显式字段，
  // 保持 AIAnalysis 主 schema 兼容的同时让诊断可查。
  const auditPatch = opts.audit ?? {};
  const auditMeta: Record<string, unknown> = {
    finishReason: response.finishReason,
    finishMessage: response.finishMessage,
    responseId: response.responseId,
    modelVersion: response.modelVersion,
    structuredOutput: response.structuredOutput,
    usedMaxTokens: response.usedMaxTokens,
    // parse 状态：成功 / 失败原因（V3.0 禁止把「parse 失败」当成功）
    parseOk: response.parseError === undefined,
    parseError: response.parseError,
    refusal: response.refusal,
    ...auditPatch,
  };
  // 去掉 undefined，避免 Dexie 里出现无意义的空键
  for (const k of Object.keys(auditMeta)) {
    if (auditMeta[k] === undefined) delete auditMeta[k];
  }

  const analysis: AIAnalysis = {
    id: newId('ai'),
    type: opts.type,
    targetId: opts.targetId,
    provider: cfg.name,
    model: cfg.model,
    systemPrompt: opts.request.systemPrompt,
    userPrompt: opts.request.userPrompt,
    rawResponse: response.raw,
    parsedResult: {
      // 保留结构化结果（若 parse 成功）
      ...(response.parsed !== undefined &&
      response.parsed !== null &&
      typeof response.parsed === 'object' &&
      !Array.isArray(response.parsed)
        ? (response.parsed as Record<string, unknown>)
        : { value: response.parsed }),
      __meta: auditMeta,
    },
    tokenUsage: response.tokenUsage,
    durationMs,
    createdAt: nowIso(),
  };
  await aiAnalysisRepo.add(analysis);
  logger.info(
    `AI analyze done type=${opts.type} provider=${cfg.name} model=${cfg.model} duration=${durationMs}ms ` +
      `finish=${response.finishReason ?? '—'} structured=${response.structuredOutput ?? '—'} parseOk=${response.parseError === undefined}`,
  );
  return { analysis, response, usedConfig: cfg };
}

/** Test the active provider connectivity */
export async function aiTestConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
  const cfg = await getActiveConfig();
  if (!cfg) return { ok: false, latencyMs: 0, message: 'no provider' };
  const adapter = buildAdapter(cfg);
  return adapter.testConnection();
}

/** List active providers for UI */
export async function listProviders() {
  return loadProvidersAsync();
}
