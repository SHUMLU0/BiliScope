import type { AIAnalysis } from '@models/task';

export type ProviderName = 'openai-compatible' | 'deepseek' | 'gemini' | 'custom';

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 自定义 header（可选），例如 Azure / 内部代理 */
  extraHeaders?: Record<string, string>;
  /**
   * 该 Provider 的默认生成上限（V3.0 · 第四节）。
   * 优先级：`AnalyzeRequest.maxTokens` → `ProviderConfig.maxTokens` → 任务默认值。
   * 不再是「所有分析一律 1024」。
   */
  maxTokens?: number;
  /** 超时毫秒 */
  timeoutMs?: number;
  /**
   * 该 Provider 是否支持 OpenAI 的 `response_format: { type: 'json_schema' }`（Structured Outputs）。
   * 默认 false（只保证 JSON 合法，不保证 schema）。
   * V3.0 按 `json_schema → json_object → prompt 约束 + 本地 Zod` 顺序降级。
   */
  supportsJsonSchema?: boolean;
  /** 该 Provider 是否支持 `response_format: { type: 'json_object' }`（JSON mode）。默认 true。 */
  supportsJsonObject?: boolean;
  /**
   * V3.0.1 · P0-A：该 Provider 是否支持**流式输出**（SSE）。
   *
   * 优先级：`AnalyzeRequest.stream` → `ProviderConfig.supportsStreaming` → 非流式 fallback。
   * 不支持流式的 Provider 不应被强制走流式（那只会让原本可用的链路直接坏掉）。
   */
  supportsStreaming?: boolean;
}

/**
 * 结构化输出能力等级。
 * 由 Provider 显式声明，adapter 据此选择请求参数并如实上报。
 */
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt_only';

export interface AnalyzeRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  temperature?: number;
  /**
   * V3.0 · 第四节：本次请求的生成上限（优先于 Provider 配置）。
   * 评论分析建议 ≥ 4096；连接测试 256；短分析 1024–2048。
   */
  maxTokens?: number;
  /**
   * V3.0 · 第三节：显式指定结构化输出能力等级。
   * 不传时按 Provider 配置与 jsonMode 推导。
   */
  structuredOutput?: StructuredOutputMode;
  /**
   * V3.0 · 第三节：JSON Schema（当 structuredOutput='json_schema' 时下发）。
   * 由 `zodToJsonSchema` 从领域 schema 生成，避免手写第二套结构。
   */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /**
   * V3.0.1 · P0-A：本次请求是否使用流式输出（SSE）。
   * 显式设置时优先于 `ProviderConfig.supportsStreaming`。
   */
  stream?: boolean;
  /**
   * V3.0.1 · P0-A：流式进度回调（仅流式链路触发）。
   * UI 用它显示「已接收 XX 字符 / 已耗时 XXs」，**不参与**任何业务判定。
   */
  onProgress?: (info: StreamProgress) => void;
}

/**
 * V3.0.1 · P0-A：流式进度快照。
 *
 * 语义严格：
 *   - `receivedChars` = 已拼接的**有效文本**字符数（不含 SSE 协议开销）
 *   - `phase`：`waiting_first_byte`（尚未收到首个 chunk）/ `streaming`（已在持续输出）
 *   - 不提供百分比，因为无法在不解析完整 JSON 的前提下知道"总量"。
 */
export interface StreamProgress {
  phase: 'waiting_first_byte' | 'streaming';
  /** 从请求发出到现在的毫秒数 */
  elapsedMs: number;
  /** 距上一次收到新数据的毫秒数 */
  sinceLastChunkMs: number;
  /** 已接收有效文本字符数 */
  receivedChars: number;
  /** 已收到的 chunk 数 */
  chunkCount: number;
}

/**
 * V3.0 · 第三节：AnalyzeResponse 必须携带**诊断信息**。
 * 只要「HTTP 成功」就返回，成败判定由 orchestrator 依据这些字段完成——
 * 不再由 adapter 偷偷把失败伪装成空 parsed。
 */
export interface AnalyzeResponse {
  text: string;
  /** 仅当 JSON.parse 成功时才有值；解析失败必须为 undefined（不许回填 raw text） */
  parsed?: unknown;
  tokenUsage?: { prompt: number; completion: number; total: number };
  /** provider 原始响应体（用于审计） */
  raw: unknown;

  // ── V3.0 新增诊断字段 ──
  /** OpenAI `choices[0].finish_reason` / Gemini `candidates[0].finishReason` */
  finishReason?: string;
  /** Gemini `candidates[0].finishMessage` 等补充说明 */
  finishMessage?: string;
  /** 供应商返回的响应 ID（OpenAI `id` / Gemini `responseId`） */
  responseId?: string;
  /** provider 返回的模型版本（Gemini `modelVersion`；OpenAI 通常为请求的 model） */
  modelVersion?: string;
  /** 模型原始文本（与 text 同源，显式保留以便审计；截断时仍是残文） */
  rawText?: string;
  /** JSON.parse 失败时的错误信息（成功时为 undefined） */
  parseError?: string;
  /** 模型拒答内容（OpenAI `message.refusal`） */
  refusal?: string;
  /** 实际下发的结构化输出等级（如实上报，便于诊断） */
  structuredOutput?: StructuredOutputMode;
  /** 实际下发的 max_tokens（如实上报，便于诊断截断原因） */
  usedMaxTokens?: number;

  // ── V3.0.1 · P0-A 新增流式诊断字段 ──
  /** 本次是否走了流式链路（如实上报） */
  streamed?: boolean;
  /** 首个有效 chunk 到达时刻（performance.now，流式才有值） */
  firstByteAt?: number;
  /** 最后一次收到有效 chunk 的时刻（performance.now，流式才有值） */
  lastChunkAt?: number;
  /** 累计 chunk 数（流式才有值） */
  chunkCount?: number;
  /** 累计接收有效文本字符数（流式才有值） */
  receivedChars?: number;
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
