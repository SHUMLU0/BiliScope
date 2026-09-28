/**
 * OpenAI-compatible Adapter（覆盖 OpenAI / DeepSeek / 多数自建 OpenAI 兼容服务）
 */

import { logger } from '@utils/logger';
import type { AIProvider, AnalyzeRequest, AnalyzeResponse, ProviderConfig, TestConnectionResult } from './types';

interface ChatResp {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAICompatibleAdapter implements AIProvider {
  readonly name: ProviderConfig['name'];
  constructor(private cfg: ProviderConfig) {
    this.name = cfg.name;
  }

  private endpoint(): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    return `${base}/chat/completions`;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
      ...(this.cfg.extraHeaders ?? {}),
    };
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      temperature: req.temperature ?? 0.2,
      max_tokens: this.cfg.maxTokens ?? 1024,
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatResp;
      const text = data.choices?.[0]?.message?.content ?? '';
      let parsed: unknown = undefined;
      if (req.jsonMode) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return {
        text,
        parsed,
        tokenUsage: data.usage
          ? {
              prompt: data.usage.prompt_tokens ?? 0,
              completion: data.usage.completion_tokens ?? 0,
              total: data.usage.total_tokens ?? 0,
            }
          : undefined,
        raw: data,
      };
    } finally {
      clearTimeout(t);
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = performance.now();
    try {
      const res = await this.analyze({
        systemPrompt: 'You are a connectivity test bot. Reply exactly "pong".',
        userPrompt: 'ping',
        temperature: 0,
        maxTokensOverride: undefined,
      } as AnalyzeRequest & { maxTokensOverride: undefined });
      void res;
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    } catch (e) {
      logger.warn('AI testConnection failed:', e);
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}