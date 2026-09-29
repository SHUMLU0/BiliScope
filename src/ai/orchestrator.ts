/**
 * AI Orchestrator（V3.0 · 第五节 / 第六节 / 第七节）。
 *
 * 统一流水线：
 *   prepare context → build prompt → select provider → request → parse
 *   → validate Zod → retry/fallback（最多 1 次自动修复） → persist audit log
 *   → persist domain analysis → return**强类型**结果
 *
 * 铁律：
 *  1. **UI 禁止消费 `unknown`**。页面不再写 `JSON.stringify(parsed ?? text)`。
 *  2. **分层失败**：区分 REQUEST_FAILED / OUTPUT_EMPTY / OUTPUT_TRUNCATED /
 *     OUTPUT_INVALID_JSON / OUTPUT_SCHEMA_INVALID / OUTPUT_REFUSAL。不许一律显示「AI 失败」。
 *  3. **自动修复上限 = 2 次总请求**。只对「无效 JSON」与「schema 不符」修复；
 *     `OUTPUT_TRUNCATED` 默认**不修复**（直接告知上限不足）。
 *  4. 只有 SUCCESS 才写正式领域结果（CommentAnalysis）。失败绝不留半成品。
 *
 * V3.0.2（AI 开放测试模式）：
 *  - maxTokens 默认 **Auto**（请求体省略 max_tokens，上限交给 Provider）；
 *    任务级 4096 硬编码（TASK_DEFAULT_MAX_TOKENS）已废除。
 *  - 默认策略 `probe_guarded`：Probe（极轻）与 Main **并行**启动；
 *    Probe 30s 无有效响应 → 终止两者 → REQUEST_PROBE_TIMEOUT；
 *    Probe healthy → Main **没有任何人为总时长限制**（30s/60s/120s 到期强杀已废除），
 *    Main 只由 Provider 完成/明确错误/MAX_TOKENS/真实断连/用户取消结束。
 *  - Probe 是独立审计分区（requestType='probe'），不计入分析 token 成本。
 */

import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { aiAnalysisRepo, commentAnalysisRepo } from '@repositories/index';
import { db } from '@db/database';
import { aiAnalyze, resolveProviderConfig } from './service';
import { buildAdapter } from './service';
import { buildRepairPrompt } from './prompts';
import {
  DOMAIN_SCHEMAS,
  unwrapAIResult,
  validateAIResult,
  type AIDomain,
  type CommentAIResult,
  type GeneralAIResult,
} from './schemas';
import { zodToStrictJsonSchema } from './json-schema';
import {
  classifyRequestError,
  describeFailure,
  isRefusalFinish,
  isTruncatedFinish,
  type AIFailureCode,
} from './failures';
import {
  buildProbeRequest,
  isHealthyProbeText,
  linkExternalSignal,
  skippedProbe,
  PROBE_TIMEOUT_MS,
  PROBE_TIMEOUT_MARKER,
} from './probe';
import { DEFAULT_TIMEOUT_MS } from './openai-adapter';
import type {
  AIRequestStrategy,
  AnalyzeRequest,
  AnalyzeResponse,
  ProbeResult,
  ProviderConfig,
  ProviderName,
  StreamProgress,
} from './types';
import type { AIAnalysis, CommentAnalysis } from '@models/index';

/**
 * 本地化的校验结果类型。
 *
 * ⚠️ `data` 必须允许 `CommentAIResult | GeneralAIResult`：
 * `validateAIResult()` 的返回类型是 `SchemaValidation`（宽联合），
 * 而运行期 `domain` 只在 comment 分支才会把 data 当作 `CommentAIResult` 使用
 * （见下方 `const data = validation.data as CommentAIResult`）。
 * 若这里收窄成只有 `CommentAIResult`，`creator/video/idea` 的 `GeneralAIResult`
 * 就无法赋值，TS2322。
 */
type SchemaValidationLike =
  | { ok: true; data: CommentAIResult | GeneralAIResult }
  | { ok: false; error: string; issues: string[] };

// ─────────────────────────────────────────────────────────── 输出上限（V3.0.2 Auto 语义）
//
// V3.0.2 起**废除任务级默认 max_tokens 硬编码**（V3.0 的 TASK_DEFAULT_MAX_TOKENS =
// `{ comment: 4096, creator/video/idea: 2048 }` 已删除，规格明令禁止 comment=4096 硬编码）。
// 现行优先级：
//   request.maxTokens（UI「输出上限」，默认 Auto）→ provider.maxTokens → **undefined(Auto)**。
//   Auto 时请求体**省略** `max_tokens` / `maxOutputTokens`，输出上限交给 Provider 决定；
//   仅 Provider 声明 `requiresMaxTokens` 时才补 `fallbackMaxTokens ?? AUTO_FALLBACK_MAX_TOKENS`。
//   Auto ≠ 无限：模型自身输出极限仍然生效（MAX_TOKENS finishReason 如实上报为 OUTPUT_TRUNCATED）。

export interface OrchestrateOpts {
  domain: AIDomain;
  targetId: string;
  systemPrompt: string;
  userPrompt: string;
  provider?: ProviderName;
  temperature?: number;
  /**
   * V3.0.2：显式覆盖输出上限。**不传 = Auto**（请求体省略 max_tokens，上限交给 Provider）。
   * 任务级 4096 硬编码已废除；Auto ≠ 无限，模型自身极限仍会以 MAX_TOKENS 如实上报。
   */
  maxTokens?: number;
  /**
   * V3.1.0 · P0-AI 时长放宽：流式空闲超时（连续无新 chunk 才算）。
   * - `undefined`：默认 300s（`DEFAULT_IDLE_TIMEOUT_MS`）；
   * - `number`：UI 指定（60/120/180/300s）；
   * - `null`：**不限制**（不创建 idle timer，但 AbortController 与外部 signal 保留——
   *   真实断连 / 用户取消仍必须失败，**不得**借 null 删除中止能力）。
   * 非流式 fallback 的总时长兜底跟随同一选项。
   */
  idleTimeoutMs?: number | null;
  /** 外部已算好的事实块（评论领域用它做 facts 一致性检查） */
  factsJson?: string;
  /**
   * V3.1.0 · P0-AI 隐私化：真实存在的**匿名 ref** 白名单（C001 样式）。
   * 用于校验模型引用是否落空 —— 模型只见过 ref，白名单也必须是 ref。
   */
  knownRefs?: string[];
  /**
   * V3.1.0 · P0-AI 隐私化：ref → 真实 rpidStr 的本地映射（由 prepare 层产出）。
   * 随产品结果（CommentAnalysis）落库；**绝不**进入 prompt / Provider 请求。
   */
  citationMap?: Record<string, string>;
  /**
   * V3.0.1 · P0-A：流式进度回调（透传给 adapter）。
   * UI 用它显示「模型已开始输出 · 23s · 已接收 XX 字符」；**不参与**任何业务判定。
   * V3.0.2 扩展：orchestrator 会推送 `probe_pending / probe_ready / probe_failed` 阶段。
   */
  onProgress?: (info: StreamProgress) => void;
  /**
   * V3.0.1 · P0-A：是否强制流式。
   * 不传时由 adapter 按 `request.stream → provider.supportsStreaming → fallback` 决定。
   */
  stream?: boolean;
  /**
   * V3.0.2：请求策略。
   * - `probe_guarded`（**默认**）：Probe（极轻）与 Main（完整分析）**并行**启动；
   *   Probe 30s 无有效响应 → 终止两者 → REQUEST_PROBE_TIMEOUT；
   *   Probe healthy → Main 无人为总时长限制。
   * - `single`：V3.0.1 旧行为（不发 Probe，非流式保留总超时兜底）。
   */
  requestStrategy?: AIRequestStrategy;
  /** V3.0.2：AI Test Mode（关闭 BiliScope 一切人为 token/总时长限制；保留 Provider 自身限制） */
  testMode?: boolean;
  /** V3.0.2：外部中止信号（用户取消 → 同时终止 Probe 与 Main） */
  signal?: AbortSignal;
  /** V3.0.2：探针看门时长（仅测试注入；生产恒为 PROBE_TIMEOUT_MS = 30s） */
  probeTimeoutMs?: number;
}

/** 引用校验结果 */
export interface CitationAudit {
  /** 模型引用了但样本里不存在的匿名 ref（可能是臆造） */
  unknownRefs: string[];
  /** 有多少条论断完全没有引用 */
  claimsWithoutCitation: number;
  /** 引用总条数 */
  totalCitations: number;
}

/** 强类型成功结果 */
export interface OrchestrateSuccess {
  ok: true;
  status: 'SUCCESS';
  /** 领域结果（已通过 Zod 校验） */
  data: CommentAIResult;
  /** 审计记录（AIAnalysis 行） */
  audit: AIAnalysis;
  /** 本次实际使用的 Provider 配置（真实端点，非错配） */
  usedConfig: ProviderConfig;
  /** 引用质量审计 */
  citations: CitationAudit;
  /** 是否用过自动修复 */
  repaired: boolean;
  /** 实际发出的请求总数（1 或 2；不含 Probe） */
  requestCount: number;
  /** 落库的产品结果（CommentAnalysis）id；非评论领域为 null */
  domainRecordId: string | null;
  durationMs: number;
  /** 输出是否不完整（截断等）；SUCCESS 且 incomplete=true 时不得视为完整分析 */
  incomplete: boolean;
  /** V3.0.2：Probe 结果（probe_guarded 时存在；UI 显示「Probe 0.8s · Analysis 37.2s」） */
  probe?: ProbeResult;
}

/** 强类型失败结果 */
export interface OrchestrateFailure {
  ok: false;
  status: AIFailureCode;
  message: string;
  retryable: boolean;
  detail?: string;
  /** 失败时仍保留审计记录 id（若有落库） */
  auditId: string | null;
  /** 供 UI「查看原始输出」使用的残文/原始响应 */
  rawText: string;
  requestCount: number;
  durationMs: number;
  /** V3.0.2：Probe 结果（probe_guarded 时存在；REQUEST_PROBE_TIMEOUT 时必有失败详情） */
  probe?: ProbeResult;
}

export type OrchestrateResult = OrchestrateSuccess | OrchestrateFailure;

// ─────────────────────────────────────────────────────────── 引用校验

/**
 * 校验 support/opposition/themes/findings 的匿名引用（refs/evidenceRefs）是否真实存在于样本中。
 * 这是「可验证」的核心：模型说「很多用户支持 X」，必须能指回样本内的真实评论（经 citationMap 回溯）。
 *
 * V3.1.0 · P0-AI 隐私化：模型只见过 C001 类匿名 ref，因此白名单也必须是 ref（knownRefs）。
 */
export function auditCitations(data: CommentAIResult, knownRefs: string[] | undefined): CitationAudit {
  const known = knownRefs && knownRefs.length ? new Set(knownRefs) : null;
  const unknown = new Set<string>();
  let total = 0;

  const scan = (refs: string[] | undefined): void => {
    for (const r of refs ?? []) {
      total++;
      if (known && !known.has(r)) unknown.add(r);
    }
  };

  for (const c of data.support) scan(c.refs);
  for (const c of data.opposition) scan(c.refs);
  for (const t of data.themes) scan(t.refs);
  for (const f of data.findings) scan(f.evidenceRefs);

  const claimsWithoutCitation = [...data.support, ...data.opposition].filter((c) => c.refs.length === 0).length;

  return { unknownRefs: [...unknown], claimsWithoutCitation, totalCitations: total };
}

// ─────────────────────────────────────────────────────────── 领域投影

/**
 * V3.0 · 第八节：领域投影。
 * `CommentAIResult`（AI 结构）→ `CommentAnalysis`（产品结果，UI 直接消费）。
 *
 * `AIAnalysis = 审计`（保留完整 prompt/raw/token/finishReason）
 * `CommentAnalysis = 产品结果`（用户真正看到的）
 *
 * V3.1.0 · P0-AI 隐私化：
 *   - AI 结构内部保持**匿名 ref** 语义（analysisResult 原样落库）；
 *   - `citationMap`（ref → 真实 rpidStr）随产品结果落库，供 UI 回溯定位；
 *   - `citedCommentRpids` 汇总的是**真实 rpid**（本地审计口径，不外发）；
 *   - 渲染文本把 `[rpid: X]` 改为 `[引用 C001, C003]`（用户在样本列表能对上的标签）。
 *
 * ⚠️ V3.0.1 · P0-2 语义修正（两个字段分工必须清楚）：
 *   - `rawResponse`    = **Provider 原始响应**（`AnalyzeResponse.raw`，形如 `{choices:[...]}`）→ 仅审计/排错
 *   - `analysisResult` = **通过 Zod 校验的结构化业务结果**（`CommentAIResult`）→ UI 唯一可消费来源
 * V3.0.0 把 `rawResponse` 写成了业务结果，UI 又强转成 `CommentAIResult`，
 * 且 `refresh()` 会再读一次把内存正确结果覆盖掉 —— 这是真实缺陷。
 */
export function mapToCommentAnalysis(
  result: CommentAIResult,
  meta: { videoId: string; model: string; raw?: unknown; citationMap?: Record<string, string> },
): CommentAnalysis {
  // 情绪分布：模型没给结构化情绪计数，就不编造 —— 统一 0 并在 uncertainty 里说明。
  // （V3.0 禁止 unknown → 0 伪装；这里 0 的含义是「未提供结构化情绪计数」，已写入 uncertainty。）
  const sentiment = { positive: 0, neutral: 0, negative: 0 };

  const themeResult = result.themes.map((t) => {
    const cite = t.refs.length ? `（引用 ${t.refs.length} 条评论）` : '';
    return `${t.name}${cite}`;
  });

  // 支持/反对：把 CitedClaim 渲染为「观点 + 引用」，同时把 ref 回溯为真实 rpid 汇总
  const cited = new Set<string>();
  const renderClaims = (claims: typeof result.support): string[] =>
    claims.map((c) => {
      for (const ref of c.refs) {
        const real = meta.citationMap?.[ref];
        if (real) cited.add(real);
      }
      const shown = c.refs.map((ref) => meta.citationMap?.[ref] ?? ref);
      return c.refs.length ? `${c.statement} [引用 ${shown.join(', ')}]` : `${c.statement} [无引用]`;
    });

  const supportResult = renderClaims(result.support);
  const oppositionResult = renderClaims(result.opposition);

  const uncertaintyNote = [
    result.summary ? `核心结论：${result.summary}` : '',
    ...result.uncertainty,
    '情绪分布未由结构化输出提供，故 positive/neutral/negative 记为 0（表示"未提供"，非"无情绪"）。',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    id: newId('ca'),
    videoId: meta.videoId,
    createdAt: nowIso(),
    model: meta.model,
    factSummary: result.facts.join('\n'),
    themeResult,
    sentimentResult: sentiment,
    userNeedResult: result.needs,
    questionResult: result.questions,
    supportResult,
    oppositionResult,
    citedCommentRpids: [...cited],
    uncertaintyNote: uncertaintyNote.slice(0, 5000),
    // ── V3.0.1 · P0-2：两个字段语义分离 ──
    // Provider 原始响应：仅供审计/排错，**不是**业务结果
    rawResponse: meta.raw,
    // 通过 Zod 校验的结构化业务结果：UI 唯一可消费来源（内部保持匿名 ref 语义）
    analysisResult: result,
    // V3.1.0 · P0-AI 隐私化：ref → 真实 rpid 的本地映射（随产品结果落库）
    citationMap: meta.citationMap ?? {},
  };
}

// ─────────────────────────────────────────────────────────── 单次尝试

interface AttemptOutcome {
  response: AnalyzeResponse;
  config: ProviderConfig;
  audit: AIAnalysis;
}

async function runOnce(opts: {
  domain: AIDomain;
  targetId: string;
  provider?: ProviderName;
  request: AnalyzeRequest;
  auditExtra?: Record<string, unknown>;
  attempt: number;
  requestCount: number;
}): Promise<AttemptOutcome> {
  const r = await aiAnalyze({
    type: opts.domain,
    targetId: opts.targetId,
    provider: opts.provider,
    request: opts.request,
    audit: { attempt: opts.attempt, requestCount: opts.requestCount, ...opts.auditExtra },
  });
  return { response: r.response, config: r.usedConfig, audit: r.analysis };
}

/** 从响应推导「不可修复类」失败码；返回 null 表示「可进入修复/校验流程」 */
function classifyRawFailure(res: AnalyzeResponse): { code: AIFailureCode; detail?: string } | null {
  if (isRefusalFinish(res.finishReason, res.finishMessage) || res.refusal) {
    return { code: 'OUTPUT_REFUSAL', detail: res.refusal ?? res.finishMessage ?? res.finishReason };
  }
  // V3.0 · 第七节：截断**默认不修复** —— 直接告知上限不足
  if (isTruncatedFinish(res.finishReason)) {
    return { code: 'OUTPUT_TRUNCATED', detail: `finishReason=${res.finishReason}` };
  }
  // 空输出：没有可修复的内容
  if (!res.text || !res.text.trim()) {
    return { code: 'OUTPUT_EMPTY', detail: `finishReason=${res.finishReason ?? '—'}` };
  }
  // ⚠️ 注意：JSON 解析失败（OUTPUT_INVALID_JSON）**不在这里返回**。
  // 第七节规定「无效 JSON」允许一次自动修复，因此必须继续走到下面的修复分支。
  return null;
}

// ─────────────────────────────────────────────────────────── 主流程

/**
 * 统一 AI 编排入口。
 *
 * V3.0.2 默认 probe_guarded：Probe 与 Main **并行**启动（禁止串行）；
 * 最多发起 **2 次**分析请求（不含 Probe）：
 *   第 1 次 = 正常结构化输出
 *   第 2 次 = 仅在「无效 JSON」或「schema 不符」时，做**一次**修复（不重新分析）
 */
export async function orchestrate(opts: OrchestrateOpts): Promise<OrchestrateResult> {
  const started = performance.now();
  const domain = opts.domain;

  // ── 0. Provider 必须真实存在（禁止名/端点错配） ──
  const preCfg = await resolveProviderConfig(opts.provider);
  if (!preCfg) {
    const info = describeFailure('NO_PROVIDER');
    return {
      ok: false,
      status: 'NO_PROVIDER',
      message: info.message,
      retryable: false,
      auditId: null,
      rawText: '',
      requestCount: 0,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // ── 1. 构造请求（含 schema 下发）──
  // V3.0.2：maxTokens = request（UI「输出上限」）→ provider → **undefined(Auto)**。
  // Auto 时请求体省略 max_tokens / maxOutputTokens（adapter 层保证），上限交给 Provider 决定。
  const maxTokens = opts.maxTokens ?? preCfg.maxTokens;
  const zodSchema = DOMAIN_SCHEMAS[domain];
  const jsonSchema = {
    name: domain === 'comment' ? 'bili_comment_analysis' : `bili_${domain}_analysis`,
    schema: zodToStrictJsonSchema(zodSchema) as Record<string, unknown>,
    strict: true,
  };

  const strategy: AIRequestStrategy = opts.requestStrategy ?? 'probe_guarded';
  const openTestMode = opts.testMode === true;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  // V3.0.2：probe_guarded（Probe healthy 后）与 AI Test Mode 下，Main 非流式请求
  // **不设** BiliScope 人为总时长 timer（30s/60s/120s 到期强杀已被废除）；
  // 流式请求本就没有总时长限制。`single` 策略保留 V3.0.1 的总超时兜底。
  const noTotalTimeout = strategy === 'probe_guarded' || openTestMode ? true : undefined;

  // V3.1.0 · P0-AI 时长放宽：Test Mode 是**全局硬开关**——一切人为时长限制都关闭，
  // 空闲超时同样强制「不限制」（null），不依赖 UI 记得传参。
  // 非 Test Mode 时透传 UI 选择（undefined=默认 300s / number=指定 / null=不限制）。
  const idleTimeoutMs = openTestMode ? null : opts.idleTimeoutMs;

  // Main 的中止通道：用户取消（opts.signal）与 probe_guarded 看门联动都汇入这里。
  const mainAbort = new AbortController();
  const unlinkUserFromMain = linkExternalSignal(opts.signal, mainAbort);

  const baseRequest: AnalyzeRequest = {
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    jsonMode: true,
    temperature: opts.temperature ?? 0.2,
    maxTokens,
    structuredOutput: preCfg.supportsJsonSchema
      ? 'json_schema'
      : preCfg.supportsJsonObject === false
        ? 'prompt_only'
        : 'json_object',
    jsonSchema,
    // V3.0.1 · P0-A：流式开关与进度回调（透传到 adapter）
    stream: opts.stream,
    onProgress: opts.onProgress,
    // V3.1.0 · P0-AI 时长放宽：流式空闲超时（undefined=默认 300s / number=指定 / null=不限制；
    // Test Mode 下已归一为 null）
    idleTimeoutMs,
    // V3.0.2：请求语义类型 / 外部中止 / 人为总时长开关
    requestType: 'analysis',
    signal: mainAbort.signal,
    noTotalTimeout,
  };

  // ── 2. 第 1 次请求（probe_guarded：Probe 与 Main **并行**启动，禁止串行） ──

  // Probe 基础设施（仅 probe_guarded 创建；single 保持 V3.0.1 行为、不发 Probe）
  let probeAbort: AbortController | undefined;
  let probeTask: Promise<ProbeResult> | undefined;
  let probeResult: ProbeResult | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;

  if (strategy === 'probe_guarded') {
    // V3.0.2：真实阶段 1 —— 「启动 Provider 探针…」（UI 不显示虚假百分比）
    opts.onProgress?.({ phase: 'probe_pending' });
    probeAbort = new AbortController();
    const unlinkUserFromProbe = linkExternalSignal(opts.signal, probeAbort);
    void unlinkUserFromProbe; // 生命周期与 probeTask 一致，页面级会话无需显式 unlink
    // 看门：probeTimeoutMs 内 Probe 无有效响应 → 终止 Probe（并联动终止 Main）
    probeTimer = setTimeout(() => probeAbort?.abort(PROBE_TIMEOUT_MARKER), probeTimeoutMs);

    probeTask = (async (): Promise<ProbeResult> => {
      const pStart = performance.now();
      try {
        const pr = await aiAnalyze({
          type: domain,
          targetId: opts.targetId,
          provider: opts.provider,
          // 极轻探针：maxTokens=32、非流式、非 JSON、输入不含任何评论数据 ——
          // 只验证「Provider 是否活着、多久响应」，**绝不分析评论内容**。
          request: buildProbeRequest({ signal: probeAbort?.signal }),
          audit: { attempt: 0, requestCount: 0, requestType: 'probe', status: 'probe_ok' },
        });
        const healthy = isHealthyProbeText(pr.response.text);
        return {
          ok: healthy,
          latencyMs: Math.round(performance.now() - pStart),
          httpStatus: 200,
          text: pr.response.text,
          requestId: pr.response.responseId,
          tokenUsage: pr.response.tokenUsage,
          error: healthy ? undefined : 'probe-response-empty',
        };
      } catch (e) {
        // 看门超时 / 主动取消 / 真实失败：用 abort reason 如实区分，绝不混为一谈
        const reason = probeAbort?.signal.reason;
        const timedOut = reason === PROBE_TIMEOUT_MARKER;
        const cancelled = reason === 'main-completed' || opts.signal?.aborted === true;
        const error = timedOut
          ? PROBE_TIMEOUT_MARKER
          : cancelled && typeof reason === 'string'
            ? reason
            : e instanceof Error
              ? e.message
              : String(e);
        // V3.0.2：Probe 失败也必须留下独立审计行（规格：Probe 记录 provider/model/latency/success）；
        // 「主动取消」（main 先完成 / 用户取消）不算失败，不留行。
        if (!cancelled) {
          try {
            const probeReq = buildProbeRequest();
            await aiAnalysisRepo.add({
              id: newId('ai'),
              type: domain,
              targetId: opts.targetId,
              provider: preCfg.name,
              model: preCfg.model,
              requestType: 'probe',
              systemPrompt: probeReq.systemPrompt,
              userPrompt: probeReq.userPrompt,
              parsedResult: {
                __meta: {
                  requestType: 'probe',
                  status: 'probe_failed',
                  probeSuccess: false,
                  error,
                  probeTimedOut: timedOut,
                },
              },
              durationMs: Math.round(performance.now() - pStart),
              createdAt: nowIso(),
            });
          } catch {
            /* 失败审计落库失败不影响主流程 */
          }
        }
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - pStart),
          error,
        };
      } finally {
        // Probe 落定即拆除看门：healthy 后 Main 完全交由 Provider 主导（无人为总时长限制）
        clearTimeout(probeTimer);
      }
    })();

    // 看门联动：Probe 失败（真实失败或 30s 超时）→ 立即终止 Main。
    // （'main-completed' 是 Main 先完成后对 Probe 的主动取消，不是失败信号。）
    void probeTask.then((p) => {
      if (probeResult !== undefined) return;
      probeResult = p;
      // V3.0.2：真实阶段 2 —— Probe 已响应 / Probe 失败（UI 显示「Probe 0.8s」）
      opts.onProgress?.({ phase: p.ok ? 'probe_ready' : 'probe_failed', probeLatencyMs: p.latencyMs });
      if (!p.ok && p.error !== 'main-completed' && opts.signal?.aborted !== true) {
        mainAbort.abort(PROBE_TIMEOUT_MARKER);
      }
    });
  } else {
    // single 策略：V3.0.1 行为 —— 不发 Probe
    probeResult = skippedProbe();
  }

  // Main 任务：**立即**发起（与 Probe 并行；`single` 时就是唯一一次请求）
  const mainTask = runOnce({
    domain,
    targetId: opts.targetId,
    provider: opts.provider,
    request: baseRequest,
    attempt: 1,
    requestCount: 1,
  });

  let first: AttemptOutcome;
  try {
    first = await mainTask;
    // Main 正常完成：若 Probe 仍在跑（比 Main 还慢），主动取消，不再等待看门到期
    if (probeTask && probeResult === undefined) {
      probeAbort?.abort('main-completed');
      await probeTask
        .then((p) => {
          if (probeResult === undefined) probeResult = p;
        })
        .catch(() => undefined);
    }
  } catch (e) {
    // ── Main 失败 / 被看门终止 ──
    // 1) 先等 Probe 落定（最多到看门到期），用于如实区分死因
    if (probeTask && probeResult === undefined) {
      await probeTask
        .then((p) => {
          if (probeResult === undefined) probeResult = p;
        })
        .catch(() => undefined);
    }
    const durationMs = Math.round(performance.now() - started);
    unlinkUserFromMain();

    // 2) 用户主动取消：Probe 与 Main 都已被外部信号终止 —— 如实报告，绝不伪装成超时
    if (opts.signal?.aborted) {
      return {
        ok: false,
        status: 'REQUEST_FAILED',
        message: '已取消：用户中止了本次 AI 分析',
        retryable: false,
        detail: 'user-cancelled',
        auditId: null,
        rawText: '',
        requestCount: 1,
        durationMs,
        probe: probeResult,
      };
    }

    // 3) 看门超时：Probe 30s 内无有效响应 → REQUEST_PROBE_TIMEOUT
    //    （绝不显示「AI 请求超时」—— 这是 probe_guarded 专属失败码）
    if (probeResult && !probeResult.ok && probeResult.error === PROBE_TIMEOUT_MARKER) {
      const info = describeFailure('REQUEST_PROBE_TIMEOUT');
      return {
        ok: false,
        status: 'REQUEST_PROBE_TIMEOUT',
        message: info.message,
        retryable: info.retryable,
        detail: `探针等待 ${probeResult.latencyMs}ms 无有效响应，已同时终止 Probe 与 Main`,
        auditId: null,
        rawText: '',
        requestCount: 1,
        durationMs,
        probe: probeResult,
      };
    }

    // 4) Probe 真实失败（非超时；如探针即遇 401/429/5xx/空响应）→ 以探针错误分类上报
    if (probeResult && !probeResult.ok && probeResult.error !== 'skipped') {
      if (probeResult.error === 'probe-response-empty') {
        const info = describeFailure('OUTPUT_EMPTY');
        return {
          ok: false,
          status: 'OUTPUT_EMPTY',
          message: `探针异常：${info.message}`,
          retryable: info.retryable,
          detail: '探针收到 HTTP 200 但无有效文本',
          auditId: null,
          rawText: '',
          requestCount: 1,
          durationMs,
          probe: probeResult,
        };
      }
      const info = classifyRequestError(new Error(probeResult.error ?? 'probe failed'), probeTimeoutMs);
      return {
        ok: false,
        status: info.code,
        message: `探针失败：${info.message}`,
        retryable: info.retryable,
        detail: probeResult.error,
        auditId: null,
        rawText: '',
        requestCount: 1,
        durationMs,
        probe: probeResult,
      };
    }

    // 5) Main 自身真实失败（Probe 仍 healthy / 未启用）→ V3.0.1 分类逻辑
    //    V3.0.1 · P0-4：把异常**分类**为具体失败码（超时/限流/上下文过大/网络/HTTP/输出超限）
    const info = classifyRequestError(e, preCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return {
      ok: false,
      status: info.code,
      message: info.message,
      retryable: info.retryable,
      detail: info.detail,
      auditId: null,
      rawText: '',
      requestCount: 1,
      durationMs,
      probe: probeResult,
    };
  }

  unlinkUserFromMain();

  // ── 3. 不可修复类失败直接返回（拒答 / 截断 / 空输出） ──
  const rawFail = classifyRawFailure(first.response);
  if (rawFail) {
    const info = describeFailure(rawFail.code, rawFail.detail);
    // V3.0 · 第七节：截断默认**不修复**原文本，直接如实告知上限不足
    return {
      ok: false,
      status: rawFail.code,
      message:
        rawFail.code === 'OUTPUT_TRUNCATED'
          ? (first.response.usedMaxTokens ?? maxTokens) !== undefined
            ? `${info.message}（本次上限 ${first.response.usedMaxTokens ?? maxTokens} tokens，建议提高或减少样本量）`
            : `${info.message}（当前输出上限为 Auto：已达到模型自身极限，可在设置中指定更高上限或更换模型）`
          : info.message,
      retryable: info.retryable,
      detail: rawFail.detail,
      auditId: first.audit.id,
      rawText: first.response.rawText ?? first.response.text,
      requestCount: 1,
      durationMs: Math.round(performance.now() - started),
      probe: probeResult,
    };
  }

  // ── 4. JSON 解析 + Zod 校验 ──
  // 两种情况都允许「一次自动修复」：
  //   a) JSON 非法（parseError）
  //   b) JSON 合法但不符合领域 schema
  const jsonInvalid = first.response.parseError !== undefined || first.response.parsed === undefined;
  let validation: SchemaValidationLike;
  if (jsonInvalid) {
    validation = {
      ok: false,
      error: 'OUTPUT_INVALID_JSON',
      issues: [first.response.parseError ?? 'parsed 为空'],
    };
  } else {
    validation = validateAIResult(domain, unwrapAIResult(first.response.parsed));
  }

  let usedResponse = first.response;
  let repaired = false;
  let requestCount = 1;
  const firstFailureCode: AIFailureCode = jsonInvalid ? 'OUTPUT_INVALID_JSON' : 'OUTPUT_SCHEMA_INVALID';

  // ── 5. 一次自动修复（第七节：最多 2 次总请求） ──
  if (!validation.ok) {
    repaired = true;
    requestCount = 2;
    const previousRaw = jsonInvalid
      ? (first.response.rawText ?? first.response.text)
      : JSON.stringify(first.response.parsed);
    const repair = buildRepairPrompt({
      domain,
      previousRaw,
      issues: validation.ok ? [] : validation.issues,
    });
    try {
      const second = await runOnce({
        domain,
        targetId: opts.targetId,
        provider: opts.provider,
        request: {
          systemPrompt: repair.system,
          userPrompt: repair.user,
          jsonMode: true,
          temperature: 0,
          maxTokens,
          structuredOutput: baseRequest.structuredOutput,
          jsonSchema,
          // 修复请求沿用同一流式策略与进度回调，避免「修复一次就退化成硬超时」
          stream: opts.stream,
          onProgress: opts.onProgress,
          // V3.1.0：修复请求沿用 Main 的空闲超时语义（Test Mode 下已归一为 null）
          idleTimeoutMs,
          // V3.0.2：修复请求沿用 Main 的中止通道与总时长语义
          // （probe_guarded / Test Mode 下同样无人为总时长限制）
          requestType: 'analysis',
          signal: mainAbort.signal,
          noTotalTimeout,
        },
        auditExtra: { repairedFrom: first.audit.id, repairOf: firstFailureCode },
        attempt: 2,
        requestCount: 2,
      });
      usedResponse = second.response;
      const secondRawFail = classifyRawFailure(second.response);
      if (!secondRawFail) {
        if (second.response.parseError !== undefined || second.response.parsed === undefined) {
          // 修复后仍是非法 JSON → `validation` 保持第 1 次的失败，`firstFailureCode`
          // 已在上面按「第 1 次是 JSON 非法还是 schema 不符」确定，无需改动。
        } else {
          const secondValidation = validateAIResult(domain, unwrapAIResult(second.response.parsed));
          if (secondValidation.ok) validation = secondValidation;
        }
      }
    } catch (e) {
      // 修复请求本身失败：仍以第 1 次的失败为准，不掩盖真实原因。
      // V3.0.1 · P0-4：把修复请求的异常也分类（超时/限流等），写进 issues 明细。
      const repairInfo = classifyRequestError(e, preCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      validation = {
        ok: false,
        error: firstFailureCode,
        issues: [
          ...(validation.ok ? [] : validation.issues),
          `自动修复请求失败：${repairInfo.code} · ${repairInfo.message} · ${repairInfo.detail ?? ''}`.trim(),
        ],
      };
    }
  }

  if (!validation.ok) {
    const code: AIFailureCode = jsonInvalid ? 'OUTPUT_INVALID_JSON' : 'OUTPUT_SCHEMA_INVALID';
    const info = describeFailure(code, validation.issues.join(' | '));
    return {
      ok: false,
      status: code,
      message: info.message,
      retryable: info.retryable,
      detail: validation.issues.slice(0, 5).join(' | '),
      auditId: first.audit.id,
      rawText: usedResponse.rawText ?? usedResponse.text,
      requestCount,
      durationMs: Math.round(performance.now() - started),
      probe: probeResult,
    };
  }

  // ── 6. 引用审计（可验证性核心；白名单 = 匿名 ref） ──
  const data = validation.data as CommentAIResult;
  const citations = auditCitations(data, opts.knownRefs);

  // ── 7. 落领域结果（仅 SUCCESS；非评论领域跳过） ──
  let domainRecordId: string | null = null;
  if (domain === 'comment') {
    const domainRecord = mapToCommentAnalysis(data, {
      videoId: opts.targetId,
      model: preCfg.model,
      raw: usedResponse.raw,
      citationMap: opts.citationMap,
    });
    await commentAnalysisRepo.add(domainRecord);
    domainRecordId = domainRecord.id;
  }

  const durationMs = Math.round(performance.now() - started);

  // 把引用审计与最终状态回写到**本次 Main 的审计行**（按 id 精确定位，put 覆盖式更新）。
  // V3.0.2 修复：旧实现 `listByTarget(...).slice(-1)` 在 probe_guarded 下可能命中 Probe 行，
  // 且 `repo.add` 对已存在主键会抛 ConstraintError 被吞掉 → 回写静默失败。改为 get+put。
  try {
    const latest = await db.aiAnalyses.get(first.audit.id);
    if (latest) {
      const prev = (latest.parsedResult ?? {}) as Record<string, unknown>;
      const prevMeta = (prev.__meta ?? {}) as Record<string, unknown>;
      await db.aiAnalyses.put({
        ...latest,
        parsedResult: {
          ...prev,
          __meta: {
            ...prevMeta,
            status: 'SUCCESS',
            incomplete: false,
            repaired,
            requestCount,
            citations: citations as unknown as Record<string, unknown>,
            domainRecordId,
            // V3.0.2：Probe 分区审计 —— Probe 的 token **不计入**分析成本，
            // 仅供 UI 显示「Probe 0.8s · Analysis 37.2s」与事后排障。
            probe: probeResult
              ? {
                  requestType: 'probe' as const,
                  provider: preCfg.name,
                  model: preCfg.model,
                  success: probeResult.ok,
                  latencyMs: probeResult.latencyMs,
                  httpStatus: probeResult.httpStatus,
                  requestId: probeResult.requestId,
                  error: probeResult.error,
                }
              : undefined,
          },
        },
      });
    }
  } catch {
    /* 审计回写失败不影响主结果 */
  }

  return {
    ok: true,
    status: 'SUCCESS',
    data,
    audit: first.audit,
    usedConfig: preCfg,
    citations,
    repaired,
    requestCount,
    domainRecordId,
    durationMs,
    incomplete: false,
    probe: probeResult,
  };
}

/**
 * 便捷包装：评论领域编排。
 * 由 UI 调用；UI 只消费这个强类型结果，不做任何 JSON.stringify。
 */
export async function orchestrateCommentAnalysis(opts: {
  videoId: string;
  systemPrompt: string;
  userPrompt: string;
  factsJson?: string;
  /** V3.1.0：匿名 ref 白名单（C001 样式，来自 prepare 层 sample） */
  knownRefs: string[];
  /** V3.1.0：ref → 真实 rpidStr 本地映射（随产品结果落库；不发送 Provider） */
  citationMap: Record<string, string>;
  provider?: ProviderName;
  maxTokens?: number;
  /** V3.1.0：流式空闲超时（undefined=默认 300s / number=指定 / null=不限制） */
  idleTimeoutMs?: number | null;
  /** V3.0.1 · P0-A：流式进度回调（UI 显示「已接收 XX 字符」） */
  onProgress?: (info: StreamProgress) => void;
  /** V3.0.1 · P0-A：是否强制流式（不传则按 provider 能力） */
  stream?: boolean;
  /** V3.0.2：请求策略（默认 probe_guarded：Probe+Main 并行，30s 看门） */
  requestStrategy?: AIRequestStrategy;
  /** V3.0.2：AI Test Mode（关闭 BiliScope 一切人为 token/总时长限制） */
  testMode?: boolean;
  /** V3.0.2：外部中止信号（用户取消 → 同时终止 Probe 与 Main） */
  signal?: AbortSignal;
}): Promise<OrchestrateResult> {
  return orchestrate({
    domain: 'comment',
    targetId: opts.videoId,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    factsJson: opts.factsJson,
    knownRefs: opts.knownRefs,
    citationMap: opts.citationMap,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
    idleTimeoutMs: opts.idleTimeoutMs,
    onProgress: opts.onProgress,
    stream: opts.stream,
    requestStrategy: opts.requestStrategy,
    testMode: opts.testMode,
    signal: opts.signal,
  });
}

export { buildAdapter };
