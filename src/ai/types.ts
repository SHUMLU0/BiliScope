import type { AIAnalysis } from '@models/task';

export type ProviderName = 'openai-compatible' | 'deepseek' | 'gemini' | 'custom';

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 自定义 header（可选），例如 Azure / 内部代理 */
  extraHeaders?: Record<string, string>;
  /** 单次最大 token（生成），防止超长账单 */
  maxTokens?: number;
  /** 超时毫秒 */
  timeoutMs?: number;
}

export interface AnalyzeRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  temperature?: number;
}

export interface AnalyzeResponse {
  text: string;
  parsed?: unknown;
  tokenUsage?: { prompt: number; completion: number; total: number };
  raw: unknown;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

export interface AIProvider {
  readonly name: ProviderName;
  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse>;
  testConnection(): Promise<TestConnectionResult>;
}

export type { AIAnalysis };