/**
 * AI Service — 业务层门面。
 * 负责：根据 active provider 选择 adapter、构造 prompt、写入 AIAnalysis 表。
 */

import { logger } from '@utils/logger';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { aiAnalysisRepo } from '@repositories/index';
import { getActiveConfig, loadProvidersAsync } from './settings';
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

function buildAdapter(cfg: ProviderConfig): AIProvider {
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

export interface ServiceAnalyzeOpts {
  type: AIAnalysis['type'];
  targetId: string;
  provider?: ProviderName;
  request: AnalyzeRequest;
}

export interface ServiceAnalyzeResult {
  analysis: AIAnalysis;
  response: AnalyzeResponse;
}

export async function aiAnalyze(opts: ServiceAnalyzeOpts): Promise<ServiceAnalyzeResult> {
  const cfg = await getActiveConfig();
  if (!cfg) throw new Error('No active AI provider configured.');
  const adapter = buildAdapter({ ...cfg, name: opts.provider ?? cfg.name });
  const start = performance.now();
  const response = await adapter.analyze(opts.request);
  const durationMs = Math.round(performance.now() - start);
  const analysis: AIAnalysis = {
    id: newId('ai'),
    type: opts.type,
    targetId: opts.targetId,
    provider: cfg.name,
    model: cfg.model,
    systemPrompt: opts.request.systemPrompt,
    userPrompt: opts.request.userPrompt,
    rawResponse: response.raw,
    parsedResult: response.parsed,
    tokenUsage: response.tokenUsage,
    durationMs,
    createdAt: nowIso(),
  };
  await aiAnalysisRepo.add(analysis);
  logger.info(`AI analyze done type=${opts.type} provider=${cfg.name} duration=${durationMs}ms`);
  return { analysis, response };
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