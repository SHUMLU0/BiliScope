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
 *
 * V3.0.1 · P0-A 升级（流式优先）：
 *  5. 默认走 `:streamGenerateContent?alt=sse`，增量拼接 `parts[].text`；
 *     JSON.parse + Zod 校验**只在流结束后做一次**。
 *  6. 与 OpenAI 一致的空闲超时模型：无总时长硬切断，连续 120s 无新 chunk 才 Abort。
 */

import { logger } from '@utils/logger';
import { linkExternalSignal } from './probe';
import { DEFAULT_TIMEOUT_MS } from './openai-adapter';
import {
  STREAM_IDLE_TIMEOUT_MS,
  consumeSseStream,
  parseSseDataLines,
} from './streaming';
import type {
  AIProvider,
  AnalyzeRequest,
  AnalyzeResponse,
  ProviderConfig,
  StreamProgress,
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

/**
 * V3.0.2：Auto 兜底上限 —— 仅当 Provider 明确 `requiresMaxTokens=true` 时使用。
 * （V3.0.x 的「任务默认 2048」已删除：BiliScope 默认不主动限制模型输出。）
 */
const AUTO_FALLBACK_MAX_TOKENS = 8192;

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

  private url(stream: boolean): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const suffix = stream ? '&alt=sse' : '';
    return `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:${method}?key=${encodeURIComponent(
      this.cfg.apiKey,
    )}${suffix}`;
  }

  /**
   * V3.0.2：Auto 优先的 maxOutputTokens 解析。
   * `request.maxTokens` → `provider.maxTokens` → **Auto（省略参数）**。
   * 仅 Provider 明确 `requiresMaxTokens=true` 时才补兜底值。
   */
  private resolveMaxTokens(req: AnalyzeRequest): number | undefined {
    const explicit = req.maxTokens ?? this.cfg.maxTokens;
    if (explicit !== undefined && explicit !== null && Number.isFinite(explicit)) {
      return Math.max(1, Math.floor(explicit));
    }
    if (this.cfg.requiresMaxTokens === true) {
      return this.cfg.fallbackMaxTokens ?? AUTO_FALLBACK_MAX_TOKENS;
    }
    return undefined;
  }

  /** 优先级：`request.stream` → `provider.supportsStreaming` → 非流式 fallback */
  private resolveStreaming(req: AnalyzeRequest): boolean {
    if (typeof req.stream === 'boolean') return req.stream;
    return this.cfg.supportsStreaming === true;
  }

  private resolveStructuredOutput(req: AnalyzeRequest): StructuredOutputMode {
    if (!req.jsonMode) return 'prompt_only';
    if (req.structuredOutput) return req.structuredOutput;
    if (req.jsonSchema && this.cfg.supportsJsonSchema !== false) return 'json_schema';
    return 'json_object';
  }

  private buildBody(
    req: AnalyzeRequest,
    m: StructuredOutputMode,
    usedMaxTokens: number | undefined,
  ): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
      // V3.0.2：Auto（undefined）时不下发 maxOutputTokens，交给 Gemini 自身上限。
      ...(usedMaxTokens !== undefined ? { maxOutputTokens: usedMaxTokens } : {}),
    };
    if (m !== 'prompt_only') {
      // responseMimeType 保证「是 JSON」；responseSchema 保证「符合结构」
      cfg.responseMimeType = 'application/json';
      if (m === 'json_schema' && req.jsonSchema) {
        cfg.responseSchema = toGeminiSchema(req.jsonSchema.schema);
      }
    }
    return {
      contents: [{ role: 'user', parts: [{ text: `${req.systemPrompt}\n\n${req.userPrompt}` }] }],
      generationConfig: cfg,
    };
  }

  /**
   * V3.0.1 · P0-A：流式请求（`:streamGenerateContent?alt=sse`）。
   * 返回与 `GeminiResp` 同形的聚合结构，下游解析代码无需区分。
   */
  private async sendStreaming(
    req: AnalyzeRequest,
    mode: StructuredOutputMode,
    usedMaxTokens: number | undefined,
  ): Promise<{ data: GeminiResp; stream: StreamMeta }> {
    const ctrl = new AbortController();
    // V3.0.2：外部中止（用户取消 / probe_guarded 联动）优先于内部看门狗
    const unlink = linkExternalSignal(req.signal, ctrl);
    const startedAt = performance.now();
    let lastChunkAt = 0;
    let firstByteAt = 0;
    let chunkCount = 0;
    let receivedChars = 0;
    let timedOut = false;

    const watchdog = setInterval(() => {
      const now = performance.now();
      const idleSince = lastChunkAt === 0 ? startedAt : lastChunkAt;
      const idleMs = now - idleSince;
      const phase: StreamProgress['phase'] = firstByteAt === 0 ? 'waiting_first_byte' : 'streaming';
      req.onProgress?.({
        phase,
        elapsedMs: Math.round(now - startedAt),
        sinceLastChunkMs: Math.round(idleMs),
        receivedChars,
        chunkCount,
      });
      if (idleMs >= STREAM_IDLE_TIMEOUT_MS) {
        timedOut = true;
        ctrl.abort();
      }
    }, 1000);

    const res = await fetch(this.url(true), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.extraHeaders ?? {}) },
      body: JSON.stringify(this.buildBody(req, mode, usedMaxTokens)),
      credentials: 'omit',
      signal: ctrl.signal,
    }).catch((e: unknown) => {
      clearInterval(watchdog);
      unlink();
      // V3.0.2：只有空闲看门狗触发的中止才改写为 idle-timeout；外部中止原样上抛
      if (timedOut) {
        throw new Error(
          `stream idle timeout: 连续 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有收到任何新响应`,
        );
      }
      throw e;
    });

    if (!res.ok) {
      clearInterval(watchdog);
      unlink();
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
    if (!res.body) {
      clearInterval(watchdog);
      unlink();
      throw new Error('stream response has no body');
    }

    // 收到响应头即上报一次 waiting_first_byte，让 UI 尽早显示「请求模型… Ns」
    req.onProgress?.({
      phase: 'waiting_first_byte',
      elapsedMs: Math.round(performance.now() - startedAt),
      sinceLastChunkMs: Math.round(performance.now() - startedAt),
      receivedChars: 0,
      chunkCount: 0,
    });

    let finishReason: string | undefined;
    let finishMessage: string | undefined;
    let responseId: string | undefined;
    let modelVersion: string | undefined;
    let usage: GeminiResp['usageMetadata'];
    let promptFeedback: GeminiResp['promptFeedback'];
    let text = '';

    try {
      await consumeSseStream(
        res.body,
        (line) => {
          const { payloads } = parseSseDataLines(line + '\n');
          for (const payload of payloads) {
            let chunk: GeminiResp;
            try {
              chunk = JSON.parse(payload) as GeminiResp;
            } catch {
              continue;
            }
            if (chunk.error?.message) throw new Error(`provider error: ${chunk.error.message}`);
            if (chunk.responseId) responseId = chunk.responseId;
            if (chunk.modelVersion) modelVersion = chunk.modelVersion;
            if (chunk.usageMetadata) usage = chunk.usageMetadata;
            if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
            const cand = chunk.candidates?.[0];
            const partText = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
            if (partText.length > 0) {
              text += partText;
              receivedChars += partText.length;
            }
            if (cand?.finishReason) finishReason = cand.finishReason;
            if (cand?.finishMessage) finishMessage = cand.finishMessage;
            const now = performance.now();
            if (firstByteAt === 0) firstByteAt = now;
            lastChunkAt = now;
            chunkCount++;
            req.onProgress?.({
              phase: 'streaming',
              elapsedMs: Math.round(now - startedAt),
              sinceLastChunkMs: 0,
              receivedChars,
              chunkCount,
            });
          }
        },
        () => timedOut,
      );
    } finally {
      clearInterval(watchdog);
      unlink();
    }

    if (timedOut) {
      throw new Error(`stream idle timeout: 连续 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有收到任何新响应`);
    }

    const aggregated: GeminiResp = {
      candidates: [{ content: { parts: [{ text }] }, finishReason, finishMessage }],
      promptFeedback,
      usageMetadata: usage,
      responseId,
      modelVersion,
    };

    return {
      data: aggregated,
      stream: { firstByteAt, lastChunkAt, chunkCount, receivedChars },
    };
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const usedMaxTokens = this.resolveMaxTokens(req);
    let mode = this.resolveStructuredOutput(req);
    const useStream = this.resolveStreaming(req);

    const sendNonStreaming = async (m: StructuredOutputMode): Promise<GeminiResp> => {
      const ctrl = new AbortController();
      // V3.0.2：外部中止优先；noTotalTimeout（probe healthy / Test Mode）时不设人为总时长 timer
      const unlink = linkExternalSignal(req.signal, ctrl);
      const timer = req.noTotalTimeout
        ? null
        : setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(this.url(false), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.cfg.extraHeaders ?? {}) },
          body: JSON.stringify(this.buildBody(req, m, usedMaxTokens)),
          credentials: 'omit',
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
        }
        return (await res.json()) as GeminiResp;
      } finally {
        if (timer !== null) clearTimeout(timer);
        unlink();
      }
    };

    let data: GeminiResp;
    let streamMeta: StreamMeta | undefined;
    try {
      if (useStream) {
        const r = await this.sendStreaming(req, mode, usedMaxTokens);
        data = r.data;
        streamMeta = r.stream;
      } else {
        try {
          data = await sendNonStreaming(mode);
        } catch (e) {
          // 降级：部分环境 / 代理不支持 responseSchema
          const msg = e instanceof Error ? e.message : String(e);
          const schemaUnsupported = mode === 'json_schema' && /400|responseSchema|response_schema|invalid/i.test(msg);
          if (!schemaUnsupported) throw e;
          logger.warn('gemini-adapter: responseSchema 不被支持，降级为 responseMimeType 单用');
          mode = 'json_object';
          data = await sendNonStreaming(mode);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const schemaUnsupported =
        useStream && mode === 'json_schema' && /400|responseSchema|response_schema|invalid/i.test(msg);
      if (!schemaUnsupported) throw e;
      logger.warn('gemini-adapter: 流式 + responseSchema 不被支持，降级为 responseMimeType 单用');
      mode = 'json_object';
      const r = await this.sendStreaming(req, mode, usedMaxTokens);
      data = r.data;
      streamMeta = r.stream;
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
      // ── V3.0.1 · P0-A 流式诊断字段 ──
      streamed: useStream,
      firstByteAt: streamMeta?.firstByteAt,
      lastChunkAt: streamMeta?.lastChunkAt,
      chunkCount: streamMeta?.chunkCount,
      receivedChars: streamMeta?.receivedChars,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = performance.now();
    try {
      const res = await this.analyze({
        systemPrompt: 'You are a connectivity test bot.',
        userPrompt: 'Reply with "pong".',
        temperature: 0,
        maxTokens: 256,
        // V3.0.1 · P0-A：连接测试显式走非流式
        stream: false,
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

interface StreamMeta {
  firstByteAt: number;
  lastChunkAt: number;
  chunkCount: number;
  receivedChars: number;
}
