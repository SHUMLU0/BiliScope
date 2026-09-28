/**
 * Gemini Adapter — 通过 Google Generative Language API。
 * API 路径：POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
 */

import { logger } from '@utils/logger';
import type { AIProvider, AnalyzeRequest, AnalyzeResponse, ProviderConfig, TestConnectionResult } from './types';

interface GeminiResp {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiAdapter implements AIProvider {
  readonly name = 'gemini' as const;
  constructor(private cfg: ProviderConfig) {}

  private url(): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
    return `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent?key=${encodeURIComponent(
      this.cfg.apiKey,
    )}`;
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const body = {
      contents: [{ role: 'user', parts: [{ text: `${req.systemPrompt}\n\n${req.userPrompt}` }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: this.cfg.maxTokens ?? 1024,
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await res.json()) as GeminiResp;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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
        tokenUsage: data.usageMetadata
          ? {
              prompt: data.usageMetadata.promptTokenCount ?? 0,
              completion: data.usageMetadata.candidatesTokenCount ?? 0,
              total: data.usageMetadata.totalTokenCount ?? 0,
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
      await this.analyze({
        systemPrompt: 'You are a connectivity test bot.',
        userPrompt: 'Reply with "pong".',
        temperature: 0,
      });
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    } catch (e) {
      logger.warn('Gemini testConnection failed:', e);
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}