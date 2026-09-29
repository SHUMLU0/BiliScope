/**
 * V3.2.1 · P1：评论 AI 结果的版本判定（正式化）。
 *
 * 为什么需要它（真实缺陷 · WHITE-SCREEN 根因链的第一环）：
 *   `CommentAnalysis.analysisResult` 的静态类型是 `CommentAIResult | undefined`，
 *   但该字段由**历代版本**写入、Dexie 直读不经过 Zod —— 运行时可能是：
 *     a) V3.2.0 研究契约的合法结果（14 字段）     → current
 *     b) V3.1.x 分类式结果（facts/themes/support/opposition/findings）→ legacy
 *     c) 损坏 / 非法数据（任意形状）              → invalid
 *     d) undefined（V3.0.x 及更早，无该列）       → 由调用方以 null/undefined 先行分流
 *   V3.2.0 的 CommentPage 只做了 `as CommentAIResult` 盲 cast，旧记录在
 *   `result.narratives.filter(...)` 处直接 throw → React 白屏。
 *
 * 判定规则（不用 try/catch 猜、不做强制迁移）：
 *   1. `validateAIResult('comment', ...)` 通过（结构签名 + Zod 语义两级）→ 'current'；
 *   2. 否则含至少一个 **legacy 特征字段**（数组形态）→ 'legacy'；
 *   3. 其余一律 'invalid'。
 *   legacy 数据**绝不**强转成新 schema —— UI 走显式降级（提示重新分析），不假装成功。
 */

import { validateAIResult } from './schemas';

export type CommentAnalysisVersion = 'current' | 'legacy' | 'invalid';

/** V3.1.x 分类式输出的特征字段：只认「数组形态」的字段，单个同名标量不算证据 */
const LEGACY_SHAPE_KEYS: readonly string[] = ['facts', 'themes', 'support', 'opposition', 'findings'];

export function detectCommentAnalysisVersion(value: unknown): CommentAnalysisVersion {
  if (validateAIResult('comment', value).ok) return 'current';
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (LEGACY_SHAPE_KEYS.some((k) => Array.isArray(obj[k]))) return 'legacy';
  }
  return 'invalid';
}
