/**
 * OpenAI-compatible Adapter（覆盖 OpenAI / DeepSeek / 多数自建 OpenAI 兼容服务）。
 *
 * V3.0 升级（第三节 / 第四节）：
 *  1. **结构化输出降级链**：`json_schema`（Structured Outputs）→ `json_object`（JSON mode）
 *     → prompt 约束 + 本地 Zod 校验。**不假设所有 OpenAI 兼容服务支持同一组参数**。
 *     - 官方口径：JSON mode 只保证「是 JSON」，Structured Outputs 才保证「符合 schema」。
 *     - 因此能上 schema 就上 schema，不能就如实上报 `structuredOutput`。
 *  2. **捕获 `finish_reason`**（含 `length` 截断、`content_filter`、拒答），
 *     不再「parse 失败 = undefined = 静默丢弃原因」。
 *  3. **`max_tokens` 三级优先级**：request.maxTokens → provider.maxTokens → 任务默认值。
 *  4. 保留 `rawText` / `parseError`，供 orchestrator 做分层失败判定与审计。
 */

import { logger } from '@utils/logger';
import type {
  AIProvider,
  AnalyzeRequest,
  AnalyzeResponse,
  ProviderConfig,
  StructuredOutputMode,
  TestConnectionResult,
} from './types';

interface ChatResp {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/** 任务默认生成上限（V3.0 · 第四节：不再是一律 1024） */
export const DEFAULT_MAX_TOKENS = 2048;

/**
 * V3.0.1 · P0-4：默认请求超时 60s。
 * V3.0.0 是 30s —— 对「结构化 JSON + 4096 输出上限」的评论分析明显偏短，
 * 会在模型正常但较慢时误报 `REQUEST_FAILED`。60s 是保守且有依据的上调（不做暴力 180s）。
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

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

  /** 三级优先级解析本次请求应有的 max_tokens */
  private resolveMaxTokens(req: AnalyzeRequest): number {
    return req.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * 决定本次下发的结构化输出等级。
   * - 未要求 jsonMode → prompt_only
   * - 显式 structuredOutput 优先
   * - 有 jsonSchema 且 provider 声明支持 json_schema → json_schema
   * - provider 未禁用 json_object → json_object
   * - 否则 prompt_only
   */
  private resolveStructuredOutput(req: AnalyzeRequest): StructuredOutputMode {
    if (!req.jsonMode) return 'prompt_only';
    if (req.structuredOutput) return req.structuredOutput;
    if (req.jsonSchema && this.cfg.supportsJsonSchema === true) return 'json_schema';
    if (this.cfg.supportsJsonObject === false) return 'prompt_only';
    return 'json_object';
  }

  private buildResponseFormat(mode: StructuredOutputMode, req: AnalyzeRequest): Record<string, unknown> | null {
    if (mode === 'json_schema' && req.jsonSchema) {
      return {
        type: 'json_schema',
        json_schema: {
          name: req.jsonSchema.name,
          strict: req.jsonSchema.strict ?? true,
          schema: req.jsonSchema.schema,
        },
      };
    }
    if (mode === 'json_object') return { type: 'json_object' };
    return null;
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const usedMaxTokens = this.resolveMaxTokens(req);
    let mode = this.resolveStructuredOutput(req);
    let responseFormat = this.buildResponseFormat(mode, req);

    const ctrl = new AbortController();
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const send = async (rf: Record<string, unknown> | null): Promise<ChatResp> => {
        const body = {
          model: this.cfg.model,
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: req.userPrompt },
          ],
          temperature: req.temperature ?? 0.2,
          max_tokens: usedMaxTokens,
          ...(rf ? { response_format: rf } : {}),
        };
        const res = await fetch(this.endpoint(), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          credentials: 'omit',
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
        }
        return (await res.json()) as ChatResp;
      };

      let data: ChatResp;
      try {
        data = await send(responseFormat);
      } catch (e) {
        // V3.0 降级：provider 不支持 json_schema 参数时（常见 400），
        // 退一级到 json_object；仍失败则交给 orchestrator 判定 REQUEST_FAILED。
        const msg = e instanceof Error ? e.message : String(e);
        const paramUnsupported = mode === 'json_schema' && /400|422|response_format|json_schema|invalid/i.test(msg);
        if (!paramUnsupported) throw e;
        logger.warn('openai-adapter: json_schema 不被支持，降级为 json_object');
        mode = this.cfg.supportsJsonObject === false ? 'prompt_only' : 'json_object';
        responseFormat = mode === 'json_object' ? { type: 'json_object' } : null;
        data = await send(responseFormat);
      }

      // 业务级错误体（部分兼容服务 HTTP 200 + error 字段）
      if (data.error?.message) {
        throw new Error(`provider error: ${data.error.message}`);
      }

      const choice = data.choices?.[0];
      const rawContent = choice?.message?.content;
      const refusal = choice?.message?.refusal ?? undefined;
      const text = typeof rawContent === 'string' ? rawContent : '';

      let parsed: unknown = undefined;
      let parseError: string | undefined;
      if (req.jsonMode) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          // V3.0：**绝不**把 raw text 当作 parsed 回填；只记录错误
          parsed = undefined;
          parseError = e instanceof Error ? e.message : String(e);
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
        // ── V3.0 诊断字段 ──
        finishReason: choice?.finish_reason,
        responseId: data.id,
        modelVersion: data.model ?? this.cfg.model,
        rawText: text,
        parseError,
        refusal,
        structuredOutput: mode,
        usedMaxTokens,
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
        // V3.0 · 第四节：连接测试只需要极短的输出（256），不占用正常分析额度
        maxTokens: 256,
      });
      // 连接测试必须确认「真的拿到了内容」，HTTP 200 但空响应不算成功
      if (!res.text.trim()) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          message: 'connected but empty response',
        };
      }
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
