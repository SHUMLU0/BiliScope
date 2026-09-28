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
 *
 * V3.0.1 · P0-A 升级（流式优先）：
 *  5. **默认走 SSE 流式**（`stream: true` + `stream_options.include_usage`），
 *     增量拼接 text，记录 `firstByteAt` / `lastChunkAt` / `chunkCount` / `receivedChars`。
 *     JSON.parse + Zod 校验**只在流接收完成后做一次**（不是每 chunk 校验）。
 *  6. **超时模型从「总时长硬切断」改为「空闲监控」**：
 *     - 首个 chunk 等待超过 30s 只提示，不终止；
 *     - 连续 120s 无新 chunk 才 Abort → 上层分类为 `REQUEST_TIMEOUT`；
 *     - **没有总时长上限**，因此「120 条评论跑 90s」不会被误判截断。
 *  7. `stream=false`（Provider 不支持流式）时走非流式 fallback，默认超时 120s。
 */

import { logger } from '@utils/logger';
import {
  FALLBACK_TIMEOUT_MS,
  STREAM_FIRST_BYTE_TIMEOUT_MS,
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

/** SSE 单条 `data:` 负载的形状（OpenAI 兼容） */
interface ChatStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/** 任务默认生成上限（V3.0 · 第四节：不再是一律 1024） */
export const DEFAULT_MAX_TOKENS = 2048;

/**
 * V3.0.1 · P0-A：非流式 fallback 的默认超时（120s）。
 * 保留旧导出名 `DEFAULT_TIMEOUT_MS` 以免破坏既有 import
 * （gemini-adapter / orchestrator / 测试都从这里取）。
 *
 * 语义变化：它现在**只用于非流式链路**；流式链路用 `STREAM_IDLE_TIMEOUT_MS` 做空闲判定。
 */
export const DEFAULT_TIMEOUT_MS = FALLBACK_TIMEOUT_MS;

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
   * 决定本次是否走流式。
   * 优先级：`request.stream` → `provider.supportsStreaming` → 非流式 fallback。
   */
  private resolveStreaming(req: AnalyzeRequest): boolean {
    if (typeof req.stream === 'boolean') return req.stream;
    return this.cfg.supportsStreaming === true;
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

  private buildBody(
    req: AnalyzeRequest,
    usedMaxTokens: number,
    rf: Record<string, unknown> | null,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      temperature: req.temperature ?? 0.2,
      max_tokens: usedMaxTokens,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(rf ? { response_format: rf } : {}),
    };
  }

  /**
   * V3.0.1 · P0-A：流式请求。
   *
   * 返回与 `ChatResp` 同形的聚合结构，使下游（解析/诊断）代码**完全无需区分**流式与否。
   * 超时由「空闲看门狗」控制，而不是总时长。
   */
  private async sendStreaming(
    req: AnalyzeRequest,
    usedMaxTokens: number,
    rf: Record<string, unknown> | null,
  ): Promise<{ data: ChatResp; stream: StreamMeta }> {
    const ctrl = new AbortController();
    const startedAt = performance.now();
    let lastChunkAt = 0;
    let firstByteAt = 0;
    let chunkCount = 0;
    let receivedChars = 0;
    let timedOut = false;

    // 空闲看门狗：每 1s 检查一次「距上次新数据」。
    // 首字节尚未到达时用 STREAM_FIRST_BYTE_TIMEOUT_MS 判定（同样不立即杀，
    // 而是在超过该阈值后把提示语切到「模型尚未返回首个响应」，真正的终止
    // 仍由 STREAM_IDLE_TIMEOUT_MS 统一决定 —— 避免两种阈值互相打架）。
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
    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, usedMaxTokens, rf, true)),
      credentials: 'omit',
      signal: ctrl.signal,
    }).catch((e: unknown) => {
      clearInterval(watchdog);
      if (timedOut || isAbortError(e)) {
        throw new Error(
          `stream idle timeout: 连续 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有收到任何新响应`,
        );
      }
      throw e;
    });

    if (!res.ok) {
      clearInterval(watchdog);
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
    if (!res.body) {
      clearInterval(watchdog);
      throw new Error('stream response has no body');
    }

    // 收到响应头即视为已建立连接 → 立刻上报一次 waiting_first_byte，
    // 让 UI 在首字节到达前就能显示「请求模型… Ns」（而不是一片空白）。
    const emitProgress = (): void => {
      const now = performance.now();
      const idleSince = lastChunkAt === 0 ? startedAt : lastChunkAt;
      req.onProgress?.({
        phase: firstByteAt === 0 ? 'waiting_first_byte' : 'streaming',
        elapsedMs: Math.round(now - startedAt),
        sinceLastChunkMs: Math.round(now - idleSince),
        receivedChars,
        chunkCount,
      });
    };
    emitProgress();

    let id: string | undefined;
    let model: string | undefined;
    let finishReason: string | undefined;
    let refusal: string | undefined;
    let usage: ChatResp['usage'];
    let providerError: string | undefined;
    let text = '';

    try {
      await consumeSseStream(
        res.body,
        (line) => {
          const { payloads } = parseSseDataLines(line + '\n');
          for (const payload of payloads) {
            let chunk: ChatStreamChunk;
            try {
              chunk = JSON.parse(payload) as ChatStreamChunk;
            } catch {
              // 不完整 / 非 JSON 的 data 行：忽略，不影响主链路
              continue;
            }
            if (chunk.error?.message) providerError = chunk.error.message;
            if (chunk.id) id = chunk.id;
            if (chunk.model) model = chunk.model;
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              text += delta;
              receivedChars += delta.length;
            }
            if (choice.delta?.refusal) refusal = choice.delta.refusal;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const now = performance.now();
            if (firstByteAt === 0) firstByteAt = now;
            lastChunkAt = now;
            chunkCount++;
            // 每个有效 chunk 都刷新一次进度，让 UI 的「已接收 N 字符」实时跟手
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
    }

    if (timedOut) {
      throw new Error(`stream idle timeout: 连续 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有收到任何新响应`);
    }
    if (providerError) {
      throw new Error(`provider error: ${providerError}`);
    }

    const aggregated: ChatResp = {
      id,
      model,
      choices: [{ finish_reason: finishReason, message: { content: text, refusal } }],
      usage,
    };

    return {
      data: aggregated,
      stream: { firstByteAt, lastChunkAt, chunkCount, receivedChars },
    };
  }

  /** 非流式请求（fallback）：默认超时 120s */
  private async sendOnce(
    req: AnalyzeRequest,
    usedMaxTokens: number,
    rf: Record<string, unknown> | null,
    timeoutMs: number,
  ): Promise<ChatResp> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(req, usedMaxTokens, rf, false)),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }
      return (await res.json()) as ChatResp;
    } finally {
      clearTimeout(t);
    }
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const usedMaxTokens = this.resolveMaxTokens(req);
    let mode = this.resolveStructuredOutput(req);
    let responseFormat = this.buildResponseFormat(mode, req);
    const useStream = this.resolveStreaming(req);
    const fallbackTimeout = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let data: ChatResp;
    let streamMeta: StreamMeta | undefined;

    try {
      if (useStream) {
        const r = await this.sendStreaming(req, usedMaxTokens, responseFormat);
        data = r.data;
        streamMeta = r.stream;
      } else {
        try {
          data = await this.sendOnce(req, usedMaxTokens, responseFormat, fallbackTimeout);
        } catch (e) {
          // V3.0 降级：provider 不支持 json_schema 参数时（常见 400），
          // 退一级到 json_object；仍失败则交给 orchestrator 判定 REQUEST_FAILED。
          const msg = e instanceof Error ? e.message : String(e);
          const paramUnsupported = mode === 'json_schema' && /400|422|response_format|json_schema|invalid/i.test(msg);
          if (!paramUnsupported) throw e;
          logger.warn('openai-adapter: json_schema 不被支持，降级为 json_object');
          mode = this.cfg.supportsJsonObject === false ? 'prompt_only' : 'json_object';
          responseFormat = mode === 'json_object' ? { type: 'json_object' } : null;
          data = await this.sendOnce(req, usedMaxTokens, responseFormat, fallbackTimeout);
        }
      }
    } catch (e) {
      // 流式链路若因为「结构化输出参数不被支持」而失败（400），降级重试一次非流式/流式
      const msg = e instanceof Error ? e.message : String(e);
      const schemaUnsupported =
        useStream && mode === 'json_schema' && /400|422|response_format|json_schema|invalid/i.test(msg);
      if (!schemaUnsupported) throw e;
      logger.warn('openai-adapter: 流式 + json_schema 不被支持，降级为 json_object');
      mode = this.cfg.supportsJsonObject === false ? 'prompt_only' : 'json_object';
      responseFormat = mode === 'json_object' ? { type: 'json_object' } : null;
      const r = await this.sendStreaming(req, usedMaxTokens, responseFormat);
      data = r.data;
      streamMeta = r.stream;
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
        systemPrompt: 'You are a connectivity test bot. Reply exactly "pong".',
        userPrompt: 'ping',
        temperature: 0,
        // V3.0 · 第四节：连接测试只需要极短的输出（256），不占用正常分析额度
        maxTokens: 256,
        // V3.0.1 · P0-A：连接测试显式走非流式，避免瞬时 SSE 连接制造噪音
        stream: false,
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

interface StreamMeta {
  firstByteAt: number;
  lastChunkAt: number;
  chunkCount: number;
  receivedChars: number;
}

/** 判断异常是否为 AbortError（DOMException / Error 两种形态） */
function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: string }).name;
  return name === 'AbortError';
}

export { STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS };
