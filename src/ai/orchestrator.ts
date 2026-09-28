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
 */

import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { aiAnalysisRepo, commentAnalysisRepo } from '@repositories/index';
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
import { DEFAULT_TIMEOUT_MS } from './openai-adapter';
import type { AnalyzeRequest, AnalyzeResponse, ProviderConfig, ProviderName } from './types';
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

// ─────────────────────────────────────────────────────────── 任务默认 token

/**
 * V3.0 · 第四节：按任务类型给默认输出上限。
 * 优先级始终是 request.maxTokens → provider.maxTokens → 这里的任务默认值。
 */
export const TASK_DEFAULT_MAX_TOKENS: Record<AIDomain, number> = {
  // 评论分析要输出 summary/facts/findings/themes/support/opposition/needs/questions/uncertainty/nextResearch
  // 1024 一定不够 —— 这是 V3.0 明确点名的截断根因。
  comment: 4096,
  creator: 2048,
  video: 2048,
  idea: 2048,
};

export interface OrchestrateOpts {
  domain: AIDomain;
  targetId: string;
  systemPrompt: string;
  userPrompt: string;
  provider?: ProviderName;
  temperature?: number;
  /** 显式覆盖输出上限 */
  maxTokens?: number;
  /** 外部已算好的事实块（评论领域用它做 facts 一致性检查） */
  factsJson?: string;
  /** 真实存在的 rpid 白名单：用于校验引用是否落空 */
  knownRpids?: string[];
}

/** 引用校验结果 */
export interface CitationAudit {
  /** 模型引用但样本里不存在的 rpid */
  unknownRpids: string[];
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
  /** 实际发出的请求总数（1 或 2） */
  requestCount: number;
  /** 落库的产品结果（CommentAnalysis）id；非评论领域为 null */
  domainRecordId: string | null;
  durationMs: number;
  /** 输出是否不完整（截断等）；SUCCESS 且 incomplete=true 时不得视为完整分析 */
  incomplete: boolean;
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
}

export type OrchestrateResult = OrchestrateSuccess | OrchestrateFailure;

// ─────────────────────────────────────────────────────────── 引用校验

/**
 * 校验 support/opposition/themes/findings 的 rpid 引用是否真实存在于样本中。
 * 这是「可验证」的核心：模型说「很多用户支持 X」，必须能指回真实评论。
 */
export function auditCitations(data: CommentAIResult, knownRpids: string[] | undefined): CitationAudit {
  const known = knownRpids && knownRpids.length ? new Set(knownRpids) : null;
  const unknown = new Set<string>();
  let total = 0;

  const scan = (rpids: string[] | undefined): void => {
    for (const r of rpids ?? []) {
      total++;
      if (known && !known.has(r)) unknown.add(r);
    }
  };

  for (const c of data.support) scan(c.rpid);
  for (const c of data.opposition) scan(c.rpid);
  for (const t of data.themes) scan(t.rpids);
  for (const f of data.findings) scan(f.evidenceRpids);

  const claimsWithoutCitation = [...data.support, ...data.opposition].filter((c) => c.rpid.length === 0).length;

  return { unknownRpids: [...unknown], claimsWithoutCitation, totalCitations: total };
}

// ─────────────────────────────────────────────────────────── 领域投影

/**
 * V3.0 · 第八节：领域投影。
 * `CommentAIResult`（AI 结构）→ `CommentAnalysis`（产品结果，UI 直接消费）。
 *
 * `AIAnalysis = 审计`（保留完整 prompt/raw/token/finishReason）
 * `CommentAnalysis = 产品结果`（用户真正看到的）
 *
 * ⚠️ V3.0.1 · P0-2 语义修正（两个字段分工必须清楚）：
 *   - `rawResponse`    = **Provider 原始响应**（`AnalyzeResponse.raw`，形如 `{choices:[...]}`）→ 仅审计/排错
 *   - `analysisResult` = **通过 Zod 校验的结构化业务结果**（`CommentAIResult`）→ UI 唯一可消费来源
 * V3.0.0 把 `rawResponse` 写成了业务结果，UI 又强转成 `CommentAIResult`，
 * 且 `refresh()` 会再读一次把内存正确结果覆盖掉 —— 这是真实缺陷。
 */
export function mapToCommentAnalysis(
  result: CommentAIResult,
  meta: { videoId: string; model: string; raw?: unknown },
): CommentAnalysis {
  // 情绪分布：模型没给结构化情绪计数，就不编造 —— 统一 0 并在 uncertainty 里说明。
  // （V3.0 禁止 unknown → 0 伪装；这里 0 的含义是「未提供结构化情绪计数」，已写入 uncertainty。）
  const sentiment = { positive: 0, neutral: 0, negative: 0 };

  const themeResult = result.themes.map((t) => {
    const cite = t.rpids.length ? `（引用 ${t.rpids.length} 条评论）` : '';
    return `${t.name}${cite}`;
  });

  // 支持/反对：把 CitedClaim 渲染为「观点 + 引用」，同时汇总引用 rpid
  const cited = new Set<string>();
  const renderClaims = (claims: typeof result.support): string[] =>
    claims.map((c) => {
      for (const r of c.rpid) cited.add(r);
      return c.rpid.length ? `${c.statement} [rpid: ${c.rpid.join(', ')}]` : `${c.statement} [无引用]`;
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
    // 通过 Zod 校验的结构化业务结果：UI 唯一可消费来源
    analysisResult: result,
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
 * 最多发起 **2 次**请求：
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

  // ── 1. 构造请求（含 schema 下发） ──
  const maxTokens = opts.maxTokens ?? preCfg.maxTokens ?? TASK_DEFAULT_MAX_TOKENS[domain];
  const zodSchema = DOMAIN_SCHEMAS[domain];
  const jsonSchema = {
    name: domain === 'comment' ? 'bili_comment_analysis' : `bili_${domain}_analysis`,
    schema: zodToStrictJsonSchema(zodSchema) as Record<string, unknown>,
    strict: true,
  };

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
  };

  // ── 2. 第 1 次请求 ──
  let first: AttemptOutcome;
  try {
    first = await runOnce({
      domain,
      targetId: opts.targetId,
      provider: opts.provider,
      request: baseRequest,
      attempt: 1,
      requestCount: 1,
    });
  } catch (e) {
    // V3.0.1 · P0-4：把异常**分类**为具体失败码（超时 / 限流 / 上下文过大 / 网络 / HTTP）
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
      durationMs: Math.round(performance.now() - started),
    };
  }

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
          ? `${info.message}（本次上限 ${first.response.usedMaxTokens ?? maxTokens} tokens，建议提高或减少样本量）`
          : info.message,
      retryable: info.retryable,
      detail: rawFail.detail,
      auditId: first.audit.id,
      rawText: first.response.rawText ?? first.response.text,
      requestCount: 1,
      durationMs: Math.round(performance.now() - started),
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
    };
  }

  // ── 6. 引用审计（可验证性核心） ──
  const data = validation.data as CommentAIResult;
  const citations = auditCitations(data, opts.knownRpids);

  // ── 7. 落领域结果（仅 SUCCESS；非评论领域跳过） ──
  let domainRecordId: string | null = null;
  if (domain === 'comment') {
    const domainRecord = mapToCommentAnalysis(data, {
      videoId: opts.targetId,
      model: preCfg.model,
      raw: usedResponse.raw,
    });
    await commentAnalysisRepo.add(domainRecord);
    domainRecordId = domainRecord.id;
  }

  const durationMs = Math.round(performance.now() - started);

  // 把引用审计与最终状态回写到审计记录的 __meta（覆盖式更新）
  try {
    const latest = (await aiAnalysisRepo.listByTarget(opts.targetId, domain)).slice(-1)[0];
    if (latest) {
      const prev = (latest.parsedResult ?? {}) as Record<string, unknown>;
      const prevMeta = (prev.__meta ?? {}) as Record<string, unknown>;
      await aiAnalysisRepo.add({
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
  knownRpids: string[];
  provider?: ProviderName;
  maxTokens?: number;
}): Promise<OrchestrateResult> {
  return orchestrate({
    domain: 'comment',
    targetId: opts.videoId,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    factsJson: opts.factsJson,
    knownRpids: opts.knownRpids,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
  });
}

export { buildAdapter };
