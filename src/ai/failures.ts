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
  /** 网络 / HTTP / Provider 报错（含超时、401、429、5xx） */
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
  REQUEST_FAILED: 'AI 请求失败（网络 / HTTP / Provider 错误）',
  OUTPUT_EMPTY: 'AI 返回了空内容（接口成功但模型没有输出）',
  OUTPUT_TRUNCATED: 'AI 输出被截断，请重试或提高输出上限',
  OUTPUT_INVALID_JSON: 'AI 输出不是合法 JSON（模型未按结构输出）',
  OUTPUT_SCHEMA_INVALID: 'AI 输出不符合分析结果结构（缺少或类型错误的字段）',
  OUTPUT_REFUSAL: 'AI 拒绝回答该请求',
  NO_PROVIDER: '未配置 AI Provider',
};

const RETRYABLE: Record<AIFailureCode, boolean> = {
  REQUEST_FAILED: true,
  OUTPUT_EMPTY: true,
  OUTPUT_TRUNCATED: true,
  OUTPUT_INVALID_JSON: true,
  OUTPUT_SCHEMA_INVALID: true,
  OUTPUT_REFUSAL: false,
  NO_PROVIDER: false,
};

export function describeFailure(code: AIFailureCode, detail?: string): AIFailureInfo {
  return { code, message: MESSAGES[code], retryable: RETRYABLE[code], detail };
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
