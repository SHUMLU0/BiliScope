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
   *
   * ⚠️ V3.0.2 语义变更：优先级 `AnalyzeRequest.maxTokens` → `ProviderConfig.maxTokens`
   * → **Auto（不主动限制）**。V3.0.x 的「任务默认值（comment 4096）」已删除 ——
   * BiliScope 不再替 Provider/模型决定它能输出多少。
   *
   * 留空 = Auto：请求体**不携带** `max_tokens`，由 Provider 自己决定上限。
   */
  maxTokens?: number;
  /**
   * V3.0.2：该 Provider **是否强制要求** `max_tokens` 参数。
   *
   * 绝大多数 OpenAI 兼容服务允许省略；少数自建/代理必须显式给出。
   * 仅当为 `true` 且当前解析结果为 Auto（undefined）时，adapter 才会回退使用
   * `fallbackMaxTokens`（若也缺失则用 `AUTO_FALLBACK_MAX_TOKENS`）——
   * 也就是说：**只有 Provider 明确不接受省略时，我们才替它补一个值**，
   * 绝不默认伪造一个低上限。
   */
  requiresMaxTokens?: boolean;
  /** `requiresMaxTokens=true` 时使用的兜底上限（留空则用 `AUTO_FALLBACK_MAX_TOKENS`） */
  fallbackMaxTokens?: number;
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
   *
   * V3.0.2：**不传 / undefined = Auto**，请求体不带 `max_tokens`，交给 Provider 决定。
   * 连接测试 256；显式指定时按指定值下发。
   */
  maxTokens?: number;
  /**
   * V3.0.2 · AI Test Mode：关闭 BiliScope 一切人为限制。
   * 仍保留 Provider / 网络 / HTTP / rate limit / context window 的真实限制。
   */
  testMode?: boolean;
  /**
   * V3.0.2 · probe_guarded：本请求的语义类型。
   * `probe`（探针，不分析） / `analysis`（正式分析）。默认 `analysis`。
   */
  requestType?: AIRequestType;
  /**
   * V3.0.2：外部中止信号（用户取消 / 暂停 / 真实断连联动）。
   * adapter 必须把它与内部看门狗 AbortController 关联；外部中止优先。
   *
   * V3.1.1：Probe **没有任何资格** abort Main —— 汇入本通道的只有
   * 用户主动操作（取消 / 暂停）与真实外部事件。
   */
  signal?: AbortSignal;
  /**
   * @deprecated V3.1.1：总时长/空闲计时统一由 `idleTimeoutMs` 决定
   * （`number` = 计时上限；`null`/`undefined` = 不限制）。本字段已不再被读取。
   */
  noTotalTimeout?: boolean;
  /**
   * V3.1.1 · P0（时长策略）：流式**空闲上限**（同时作为非流式总时长上限）。
   *
   * 语义（二态，默认不限制）：
   *  - `number`           = 计时上限毫秒（UI 选项 60/120/180/300/600/900/1800s）；
   *  - `null` / `undefined` = **不限制**：不创建任何 BiliScope 人为 timer，
   *    请求只由 Provider 完成 / 明确错误 / 真实断连 / 用户暂停或取消结束。
   *
   * ⚠️ 红线一：不限制 ≠ 删除中止能力 —— AbortController 与外部 `signal`
   * 照常工作，真实断连仍必须失败。AI Test Mode 传 null。
   * ⚠️ 红线二：不再存在任何隐藏的 30/60/120s 默认 timer —— 不设置就是不限制。
   */
  idleTimeoutMs?: number | null;
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
 * V3.0.2：请求语义类型。用于**审计分区** —— 探针不得污染分析的成本/结果。
 */
export type AIRequestType = 'analysis' | 'probe';

/**
 * AI 请求策略。
 *  - `single`        ：仅发一次正式分析请求（不发探针）
 *  - `probe_guarded` ：**并行**发 Probe（轻，旁路诊断）+ Main（完整分析）；
 *                      V3.1.1 起 Probe 只诊断不干预 —— 任何探针结果
 *                      都不终止 Main、不影响 Main 成败。
 */
export type AIRequestStrategy = 'single' | 'probe_guarded';

/**
 * V3.0.1 · P0-A：流式进度快照。
 *
 * 语义严格：
 *   - `receivedChars` = 已拼接的**有效文本**字符数（不含 SSE 协议开销）
 *   - `phase`：`waiting_first_byte`（尚未收到首个 chunk）/ `streaming`（已在持续输出）
 *   - 不提供百分比，因为无法在不解析完整 JSON 的前提下知道"总量"。
 *
 * V3.0.2 扩展 `phase`：探针阶段（`probe_*`）由 probe_guarded 模式产生。
 */
export interface StreamProgress {
  phase:
    | 'waiting_first_byte'
    | 'streaming'
    | 'probe_pending'
    | 'probe_ready'
    | 'probe_failed'
    | 'probe_timeout';
  /**
   * 从请求发出到现在的毫秒数。
   * V3.0.2：probe_* 阶段没有流字段 —— 以下 4 个流字段仅在 waiting_first_byte / streaming 阶段有意义
   * （由 adapter 推送时保证有值）；probe 阶段推送允许省略。
   */
  elapsedMs?: number;
  /** 距上一次收到新数据的毫秒数（仅流阶段） */
  sinceLastChunkMs?: number;
  /** 已接收有效文本字符数（仅流阶段） */
  receivedChars?: number;
  /** 已收到的 chunk 数（仅流阶段） */
  chunkCount?: number;
  /** V3.0.2：探针耗时（仅 probe_* 阶段有值） */
  probeLatencyMs?: number;
  /**
   * V3.1.1：探针诊断状态与详情（仅 probe_* 阶段有值）。
   * UI 用它显示独立的「探针：…」状态行 —— 探针异常**不改变** Main 的独立显示。
   */
  probeStatus?: ProbeStatus;
  /** V3.1.1：探针诊断详情（如 `HTTP 401` / `连接成功但没有可用模型输出`） */
  probeDetail?: string;
}

/**
 * V3.1.1 · Probe 诊断状态（与 Main 互不决定业务结果）。
 *  - `pending`  ：探针尚未落定
 *  - `healthy`  ：HTTP 2xx 且有模型文本
 *  - `warning`  ：HTTP 2xx 但空响应（连接成功、模型没说话）—— 仅诊断警告，**不是**失败
 *  - `timeout`  ：30s 观察窗内无响应（Probe 自己结束，**不波及** Main）
 *  - `failed`   ：HTTP 4xx/5xx / 网络错误 / 解析错误 —— 仅诊断，**不波及** Main
 *  - `skipped`  ：single 策略未发探针
 */
export type ProbeStatus = 'pending' | 'healthy' | 'warning' | 'timeout' | 'failed' | 'skipped';

/**
 * V3.0.2 · Probe（探针）结果 —— **旁路诊断**（V3.1.1 语义），不产生业务结果。
 *
 * V3.1.1 核心变更：Probe 从「Main 看门人」降级为「Provider 连通性观察器」：
 *  - `transportConnected`：HTTP 层是否成功收到响应（2xx 即 true，**包括空响应**）；
 *  - `modelResponded`：响应体是否有模型文本；
 *  - 空响应 → `status='warning'`（连接成功但没有可用模型输出），**不是** OUTPUT_EMPTY；
 *  - Probe 的任何失败（401/429/500/网络/空/超时）都只进入本对象与 UI 诊断，
 *    **绝不** abort Main、**绝不**改写 Main 的成败。
 */
export interface ProbeResult {
  /** transport 请求是否成功完成（2xx = true，含空响应；false 仅限 HTTP/网络/解析错误与超时） */
  ok: boolean;
  /** V3.1.1：诊断状态 */
  status: ProbeStatus;
  /** V3.1.1：HTTP 连接是否成功（2xx） */
  transportConnected: boolean;
  /** V3.1.1：模型是否返回了文本 */
  modelResponded: boolean;
  /** 探针耗时（ms） */
  latencyMs: number;
  /** HTTP 状态码（若已到达） */
  httpStatus?: number;
  /** Provider/模型返回的简短文本（截断保存） */
  text?: string;
  /** 失败/警告原因（status='failed' 时必有；'warning' 时为空响应说明） */
  error?: string;
  /** Provider 返回的请求 ID（有则保存） */
  requestId?: string;
  /** 探针单独的 token 用量（若 Provider 返回） */
  tokenUsage?: { prompt: number; completion: number; total: number };
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
  /**
   * 实际下发的 max_tokens（如实上报，便于诊断截断原因）。
   * V3.0.2：Auto 模式下**省略参数**时为 `undefined`（表示「未由 BiliScope 限制」）。
   */
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
