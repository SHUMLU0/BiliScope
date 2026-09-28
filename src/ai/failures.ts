/**
 * AI 分层的失败类型（V3.0 · 第六节）。
 *
 * ⚠️ 禁止把所有失败都显示成「AI 失败」。
 * 用户必须能看到真实原因：是网络挂了、模型没输出、输出被截断、JSON 不合法、
 * 不符合业务 schema、还是模型拒答。
 *
 * 与 `完成` 严格互斥：只有 `SUCCESS` 才允许写正式领域结果（CommentAnalysis）。
 */

export const AI_FAILURE_CODES = [
  /**
   * V3.0.1 · P0-4：请求层失败细分（不再把所有请求问题压成 `REQUEST_FAILED`）。
   * UI 必须显示**真实原因**，`技术细节：空` 是被禁止的。
   */
  /** 请求超时（AbortError / 超时中断）—— 默认 60s */
  'REQUEST_TIMEOUT',
  /** HTTP 非 2xx（4xx/5xx），携带状态码 */
  'REQUEST_HTTP_ERROR',
  /** 网络层错误（DNS / 连接被拒 / CORS / 断网） */
  'REQUEST_NETWORK_ERROR',
  /** HTTP 429 限流 */
  'REQUEST_RATE_LIMITED',
  /** HTTP 413 / 400 明确指示输入过大 —— 需要减少 AI 样本量 */
  'REQUEST_CONTEXT_TOO_LARGE',
  /** Provider 侧业务错误体（HTTP 200 + error 字段 / 模型不存在等） */
  'REQUEST_PROVIDER_ERROR',
  /** 兜底：未能归类的请求失败（诊断信息必须非空） */
  'REQUEST_FAILED',
  /** HTTP 200 但模型没有产出任何可用内容（空串 / 只有空白） */
  'OUTPUT_EMPTY',
  /** 输出被 token 上限截断（finishReason=length / MAX_TOKENS） */
  'OUTPUT_TRUNCATED',
  /** 拿到非空文本，但 JSON.parse 失败 */
  'OUTPUT_INVALID_JSON',
  /** JSON 合法，但不符合领域 Zod schema */
  'OUTPUT_SCHEMA_INVALID',
  /** 模型明确拒答（refusal / SAFETY / PROHIBITED_CONTENT） */
  'OUTPUT_REFUSAL',
  /** 未配置 Provider */
  'NO_PROVIDER',
] as const;

export type AIFailureCode = (typeof AI_FAILURE_CODES)[number];

/** 成功码（仅此一个） */
export const AI_SUCCESS = 'SUCCESS' as const;
export type AIStatus = AIFailureCode | typeof AI_SUCCESS;

export interface AIFailureInfo {
  code: AIFailureCode;
  /** 面向用户的短句（中文，说明真实原因） */
  message: string;
  /** 该失败是否值得再试（不用于自动无限重试，只用于 UI 按钮文案） */
  retryable: boolean;
  /** 原始错误细节（不展示给普通用户，仅「原始输出」与诊断区） */
  detail?: string;
}

const MESSAGES: Record<AIFailureCode, string> = {
  REQUEST_TIMEOUT: 'AI 请求超时',
  REQUEST_HTTP_ERROR: 'AI 请求返回 HTTP 错误',
  REQUEST_NETWORK_ERROR: 'AI 请求网络错误（无法连接到 Provider）',
  REQUEST_RATE_LIMITED: 'Provider 限流（请求过于频繁）',
  REQUEST_CONTEXT_TOO_LARGE: '输入内容过大：请减少 AI 分析样本数量',
  REQUEST_PROVIDER_ERROR: 'Provider 返回错误',
  REQUEST_FAILED: 'AI 请求失败',
  OUTPUT_EMPTY: 'AI 返回了空内容（接口成功但模型没有输出）',
  OUTPUT_TRUNCATED: 'AI 输出被截断，请重试或提高输出上限',
  OUTPUT_INVALID_JSON: 'AI 输出不是合法 JSON（模型未按结构输出）',
  OUTPUT_SCHEMA_INVALID: 'AI 输出不符合分析结果结构（缺少或类型错误的字段）',
  OUTPUT_REFUSAL: 'AI 拒绝回答该请求',
  NO_PROVIDER: '未配置 AI Provider',
};

const RETRYABLE: Record<AIFailureCode, boolean> = {
  REQUEST_TIMEOUT: true,
  REQUEST_HTTP_ERROR: true,
  REQUEST_NETWORK_ERROR: true,
  REQUEST_RATE_LIMITED: true,
  REQUEST_CONTEXT_TOO_LARGE: false,
  REQUEST_PROVIDER_ERROR: false,
  REQUEST_FAILED: true,
  OUTPUT_EMPTY: true,
  OUTPUT_TRUNCATED: true,
  OUTPUT_INVALID_JSON: true,
  OUTPUT_SCHEMA_INVALID: true,
  OUTPUT_REFUSAL: false,
  NO_PROVIDER: false,
};

/** 请求类失败码（由 classifyRequestError 产出） */
export const REQUEST_FAILURE_CODES = [
  'REQUEST_TIMEOUT',
  'REQUEST_HTTP_ERROR',
  'REQUEST_NETWORK_ERROR',
  'REQUEST_RATE_LIMITED',
  'REQUEST_CONTEXT_TOO_LARGE',
  'REQUEST_PROVIDER_ERROR',
  'REQUEST_FAILED',
] as const satisfies readonly AIFailureCode[];

export type RequestFailureCode = (typeof REQUEST_FAILURE_CODES)[number];

/**
 * V3.0.1 · P0-4：把适配器抛出的异常**分类**为具体失败码。
 *
 * 为什么必须分类：V3.0.0 把所有异常都写成 `REQUEST_FAILED`，
 * 用户看到「AI 请求失败」却不知道是超时、限流、还是输入过大 —— 无法自助修复。
 *
 * 判定优先级（从严到宽）：
 *   1. AbortError（超时中断）→ REQUEST_TIMEOUT
 *   2. HTTP 413 / 400 + 上下文过大关键词 → REQUEST_CONTEXT_TOO_LARGE
 *   3. HTTP 429 → REQUEST_RATE_LIMITED
 *   4. 模型不存在 / 404 → REQUEST_PROVIDER_ERROR
 *   5. 其他 HTTP 状态码 → REQUEST_HTTP_ERROR
 *   6. 网络层关键词 → REQUEST_NETWORK_ERROR
 *   7. provider error 业务体 → REQUEST_PROVIDER_ERROR
 *   8. 兜底 → REQUEST_FAILED
 */
export function classifyRequestError(e: unknown, timeoutMs?: number): AIFailureInfo {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  const suffix = timeoutMs ? `（${Math.round(timeoutMs / 1000)}s）` : '';

  // 1. 超时：AbortError / 明确超时措辞
  if (name === 'AbortError' || /abort|timeout|timed out|超时/i.test(msg)) {
    return {
      code: 'REQUEST_TIMEOUT',
      message: `AI 请求超时${suffix}`,
      retryable: true,
      detail: msg || name || 'AbortError（未携带消息）',
    };
  }

  // 2. 上下文过大：HTTP 413，或 400 且明确指出 input/context 过大
  const is413 = /\bhttp\s*413\b/i.test(msg);
  const is400 = /\bhttp\s*400\b/i.test(msg);
  const tooLarge = /context[_ ]length|maximum context|too many tokens|token.{0,10}limit|prompt is too long|input.{0,10}too large|request entity too large/i.test(
    msg,
  );
  if (is413 || (is400 && tooLarge)) {
    return {
      code: 'REQUEST_CONTEXT_TOO_LARGE',
      message: '输入内容过大：请减少 AI 分析样本数量',
      retryable: false,
      detail: msg,
    };
  }

  // 3. 限流
  if (/\bhttp\s*429\b|rate[_ ]?limit|too many requests/i.test(msg)) {
    return {
      code: 'REQUEST_RATE_LIMITED',
      message: 'Provider 限流（请求过于频繁），请稍后重试',
      retryable: true,
      detail: msg,
    };
  }

  // 4. 模型不存在 / 无权限
  if (
    /model[_ ]?not[_ ]?found|does not exist|unknown model|no such model|model.{0,20}not available|invalid model/i.test(
      msg,
    ) ||
    /\bhttp\s*404\b/i.test(msg)
  ) {
    return {
      code: 'REQUEST_PROVIDER_ERROR',
      message: 'Model 不存在 / 不可用：请检查 Provider 的 Model 配置',
      retryable: false,
      detail: msg,
    };
  }

  // 5. 其他 HTTP 错误（含 401 / 403 / 5xx）
  const httpMatch = msg.match(/\bhttp\s*(\d{3})\b/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const hint =
      status === 401 || status === 403
        ? '（认证失败：请检查 API Key）'
        : status >= 500
          ? '（Provider 服务端错误，可稍后重试）'
          : '';
    return {
      code: 'REQUEST_HTTP_ERROR',
      message: `AI 请求返回 HTTP ${status}${hint}`,
      retryable: status >= 500 || status === 408,
      detail: msg,
    };
  }

  // 6. 网络层
  if (
    /failed to fetch|networkerror|network error|econnrefused|enotfound|err_connection|dns|cors|load failed/i.test(
      lower,
    )
  ) {
    return {
      code: 'REQUEST_NETWORK_ERROR',
      message: 'AI 请求网络错误（无法连接到 Provider，请检查 Base URL 与网络）',
      retryable: true,
      detail: msg,
    };
  }

  // 7. Provider 业务错误体
  if (/provider error/i.test(msg)) {
    return {
      code: 'REQUEST_PROVIDER_ERROR',
      message: 'Provider 返回错误',
      retryable: false,
      detail: msg,
    };
  }

  // 8. 兜底：detail 必须非空（禁止「技术细节：空」）
  return {
    code: 'REQUEST_FAILED',
    message: 'AI 请求失败（未能归类的错误，详见技术细节）',
    retryable: true,
    detail: msg || '未知错误（无 message）',
  };
}

export function describeFailure(code: AIFailureCode, detail?: string): AIFailureInfo {
  const trimmed = detail?.trim();
  return {
    code,
    message: MESSAGES[code],
    retryable: RETRYABLE[code],
    // 兜底：即使调用方没给 detail，也绝不留空（UI 显示「技术细节：空」是被禁止的）
    detail: trimmed && trimmed.length > 0 ? trimmed : `无附加细节（code=${code}）`,
  };
}

/** 把模型侧的 finishReason 归一化为「是否被截断」 */
export function isTruncatedFinish(reason: string | undefined | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === 'length' || r === 'max_tokens' || r === 'max_output_tokens' || r === 'maxtokens';
}

/** 把模型侧的 finishReason 归一化为「是否拒答」 */
export function isRefusalFinish(
  reason: string | undefined | null,
  finishMessage?: string,
): boolean {
  const all = `${reason ?? ''} ${finishMessage ?? ''}`.toLowerCase();
  return (
    all.includes('refusal') ||
    all.includes('safety') ||
    all.includes('prohibited_content') ||
    all.includes('blocklist') ||
    all.includes('recitation')
  );
}
