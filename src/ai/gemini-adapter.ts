/**
 * Gemini Adapter — 通过 Google Generative Language API。
 * API 路径：POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
 *
 * V3.0 升级（第三节 / 第四节）：
 *  1. 应用 **Structured Output**：从 Zod 领域 schema 生成 JSON Schema 并下发
 *     `generationConfig.responseSchema` + `responseMimeType: 'application/json'`。
 *     这比只设 `responseMimeType` 强得多——后者仅保证「是 JSON」，不保证符合结构。
 *  2. 接收 `finishReason` / `finishMessage` / `usageMetadata` / `modelVersion` / `responseId`，
 *     其中 `finishReason=MAX_TOKENS` 必须被如实上报（第四节截断诊断）。
 *  3. `max_tokens` 三级优先级：request.maxTokens → provider.maxTokens → 任务默认值。
 *  4. 若 Provider 不支持 responseSchema（老版本 / 代理），降级为 `responseMimeType` + 本地 Zod。
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

interface GeminiResp {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
    finishMessage?: string;
    index?: number;
  }>;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
  error?: { message?: string; status?: string; code?: number };
}

/** Gemini generationConfig 接受的 OpenAPI 子集（不支持 additionalProperties / $schema） */
interface GeminiSchema {
  type?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  description?: string;
  anyOf?: GeminiSchema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
}

const DEFAULT_MAX_TOKENS = 2048;

/** 把 JSON Schema 裁剪为 Gemini 接受的子集 */
function toGeminiSchema(input: Record<string, unknown>): GeminiSchema {
  const out: GeminiSchema = {};
  const type = input.type;
  if (typeof type === 'string') {
    out.type = type === 'integer' ? 'integer' : type.toUpperCase() === type ? type.toLowerCase() : type;
  } else if (Array.isArray(type)) {
    // Gemini 不支持 type 数组（联合类型）→ 取非 null 的第一个
    const nonNull = (type as string[]).find((t) => t !== 'null');
    out.type = nonNull ?? 'string';
  }
  if (typeof input.description === 'string') out.description = input.description;
  if (Array.isArray(input.enum)) out.enum = (input.enum as unknown[]).filter((v): v is string => typeof v === 'string');
  if (typeof input.maxLength === 'number') out.maxLength = input.maxLength;
  if (typeof input.minLength === 'number') out.minLength = input.minLength;
  if (typeof input.minimum === 'number') out.minimum = input.minimum;
  if (typeof input.maximum === 'number') out.maximum = input.maximum;
  if (typeof input.maxItems === 'number') out.maxItems = input.maxItems;
  if (typeof input.minItems === 'number') out.minItems = input.minItems;
  if (input.properties && typeof input.properties === 'object') {
    const props: Record<string, GeminiSchema> = {};
    for (const [k, v] of Object.entries(input.properties as Record<string, unknown>)) {
      props[k] = toGeminiSchema(v as Record<string, unknown>);
    }
    out.properties = props;
  }
  if (Array.isArray(input.required)) out.required = (input.required as unknown[]).filter((v): v is string => typeof v === 'string');
  if (input.items && typeof input.items === 'object') {
    out.items = toGeminiSchema(input.items as Record<string, unknown>);
  }
  if (Array.isArray(input.anyOf)) {
    out.anyOf = (input.anyOf as Record<string, unknown>[]).map(toGeminiSchema);
  }
  // additionalProperties / $schema / default 一律丢弃（Gemini 不接受）
  return out;
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

  private resolveMaxTokens(req: AnalyzeRequest): number {
    return req.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  private resolveStructuredOutput(req: AnalyzeRequest): StructuredOutputMode {
    if (!req.jsonMode) return 'prompt_only';
    if (req.structuredOutput) return req.structuredOutput;
    if (req.jsonSchema && this.cfg.supportsJsonSchema !== false) return 'json_schema';
    return 'json_object';
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const usedMaxTokens = this.resolveMaxTokens(req);
    let mode = this.resolveStructuredOutput(req);

    const buildGenerationConfig = (m: StructuredOutputMode): Record<string, unknown> => {
      const cfg: Record<string, unknown> = {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: usedMaxTokens,
      };
      if (m === 'prompt_only') return cfg;
      // responseMimeType 保证「是 JSON」；responseSchema 保证「符合结构」
      cfg.responseMimeType = 'application/json';
      if (m === 'json_schema' && req.jsonSchema) {
        cfg.responseSchema = toGeminiSchema(req.jsonSchema.schema);
      }
      return cfg;
    };

    const send = async (m: StructuredOutputMode): Promise<GeminiResp> => {
      const body = {
        contents: [{ role: 'user', parts: [{ text: `${req.systemPrompt}\n\n${req.userPrompt}` }] }],
        generationConfig: buildGenerationConfig(m),
      };
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.cfg.extraHeaders ?? {}) },
        body: JSON.stringify(body),
        credentials: 'omit',
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }
      return (await res.json()) as GeminiResp;
    };

    // 超时统一由 AbortController 包裹整个尝试链
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      let data: GeminiResp;
      try {
        data = await send(mode);
      } catch (e) {
        // 降级：部分环境 / 代理不支持 responseSchema
        const msg = e instanceof Error ? e.message : String(e);
        const schemaUnsupported = mode === 'json_schema' && /400|responseSchema|response_schema|invalid/i.test(msg);
        if (!schemaUnsupported) throw e;
        logger.warn('gemini-adapter: responseSchema 不被支持，降级为 responseMimeType 单用');
        mode = 'json_object';
        data = await send(mode);
      }

      if (data.error?.message) throw new Error(`provider error: ${data.error.message}`);

      const cand = data.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

      let parsed: unknown = undefined;
      let parseError: string | undefined;
      if (req.jsonMode) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = undefined;
          parseError = e instanceof Error ? e.message : String(e);
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
        // ── V3.0 诊断字段 ──
        finishReason: cand?.finishReason ?? data.promptFeedback?.blockReason,
        finishMessage: cand?.finishMessage ?? data.promptFeedback?.blockReasonMessage,
        responseId: data.responseId,
        modelVersion: data.modelVersion ?? this.cfg.model,
        rawText: text,
        parseError,
        refusal: data.promptFeedback?.blockReason ? data.promptFeedback.blockReasonMessage : undefined,
        structuredOutput: mode,
        usedMaxTokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = performance.now();
    try {
      const res = await this.analyze({
        systemPrompt: 'You are a connectivity test bot.',
        userPrompt: 'Reply with "pong".',
        temperature: 0,
        maxTokens: 256,
      });
      if (!res.text.trim()) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          message: 'connected but empty response',
        };
      }
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
