/**
 * V3.1.1 · P0：Main Request 不可变快照指纹（requestFingerprint）。
 *
 * 规格（§四）：AI 开始时冻结 Main 请求的不可变快照 —— 至少覆盖
 * systemPrompt / userPrompt / temperature / maxTokens / structuredOutput /
 * jsonSchema / stream / idleTimeoutMs / model / provider（AI sample 已拼入 userPrompt）。
 *
 * 用途：
 *  1. `fingerprintBefore === fingerprintAfter` 证明 Probe / 修复流程**从未 mutate** Main 请求；
 *  2. 暂停后「继续分析」复用完全相同的输入快照 → 两次指纹一致（PAUSE-003）。
 *
 * 稳定性要求：序列化**手动拼接字段**（不用 JSON.stringify 整个 request ——
 * request 上挂着 signal/onProgress 等函数与 AbortSignal，且 key 顺序不稳定）。
 * 哈希：SHA-256（crypto.subtle，浏览器与 Node 18+ 均可用）。
 */

export interface FingerprintFields {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  /** undefined = Auto（请求体省略 max_tokens） */
  maxTokens?: number;
  structuredOutput?: string;
  jsonSchemaName?: string;
  stream?: boolean;
  /** null = 不限制 */
  idleTimeoutMs?: number | null;
  provider: string;
  model: string;
}

/** 稳定序列化（字段固定顺序；maxTokens 用 'auto' 显式表达省略） */
export function stableRequestSerialization(f: FingerprintFields): string {
  return [
    'v3.1.1',
    f.systemPrompt,
    f.userPrompt,
    f.temperature === undefined ? 'auto-temp' : String(f.temperature),
    f.maxTokens === undefined ? 'auto' : String(f.maxTokens),
    f.structuredOutput ?? '',
    f.jsonSchemaName ?? '',
    f.stream ? 'stream' : 'nonstream',
    f.idleTimeoutMs === null || f.idleTimeoutMs === undefined ? 'unlimited' : String(f.idleTimeoutMs),
    f.provider,
    f.model,
  ].join('\u0000');
}

/** SHA-256 hex（crypto.subtle 异步；Node 18+ / Chrome 均内置） */
export async function computeRequestFingerprint(f: FingerprintFields): Promise<string> {
  const data = new TextEncoder().encode(stableRequestSerialization(f));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
