/**
 * AI 结果统一 Schema（V3.0 · 可验证 AI 分析系统）。
 *
 * ⚠️ 第一性原理（用户强制要求）：
 *   **AI 输出必须是「可验证的数据」，不是「一段字符串」。**
 *   禁止把 `JSON.parse(text)` 成功当作分析成功——那只能证明「模型吐出了合法 JSON」，
 *   不能证明「结果符合 BiliScope 的业务契约」。
 *
 * 设计约束：
 *  1. **一个领域 = 一份 schema，一处定义，所有 Provider 共用**。
 *     不允许 comment prompt 或任何 adapter 再定义第二套 schema。
 *  2. 区分「客观事实」与「AI 解释」：
 *     - `facts`  = 来自给定数据的事实（数字必须能在输入里找到）
 *     - `findings` = AI 的解释性判断（必须能指向证据 rpid）
 *  3. 引用必须落到真实 rpid：`support` / `opposition` 每项都带 `rpid: string[]`。
 *  4. `uncertainty` 必须说明「哪些无法确认」（样本量 / 清洗 / 抽样偏差 / 数据完整性）。
 *  5. `nextResearch` 只能是「下一步要采什么数据」，不得伪装成结论。
 */

import { z } from 'zod';

/** 解释性发现的类型 */
export const findingTypeEnum = z.enum(['theme', 'painpoint', 'emotion', 'controversy', 'behavior']);
export type FindingType = z.infer<typeof findingTypeEnum>;

/**
 * AI 的解释性发现。
 * - `statement`：一句可独立阅读的判断
 * - `evidenceRpids`：支撑该判断的原始评论 rpid（字符串，保精度）；允许为空数组，
 *   但为空时 UI 会显式标注「无引用」，不假装有证据。
 */
export const findingSchema = z.object({
  type: findingTypeEnum,
  statement: z.string().min(1).max(1000),
  evidenceRpids: z.array(z.string().min(1)).max(50).default([]),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * 带引用的论断（支持 / 反对共用）。
 * `rpid` 使用数组，因为一个论断常由多条评论共同支撑。
 */
export const citedClaimSchema = z.object({
  statement: z.string().min(1).max(1000),
  rpid: z.array(z.string().min(1)).max(50).default([]),
});
export type CitedClaim = z.infer<typeof citedClaimSchema>;

/** 主题（comment 领域必需项） */
export const themeSchema = z.object({
  name: z.string().min(1).max(200),
  /** 主题对应的评论 rpid（原文引用） */
  rpids: z.array(z.string().min(1)).max(100).default([]),
  /** 提及该主题的评论条数（可选，模型不得编造；无法判断时省略） */
  mentionCount: z.number().int().nonnegative().optional(),
});
export type Theme = z.infer<typeof themeSchema>;

/**
 * 评论分析的领域结果（V3.0 唯一真相）。
 *
 * 字段顺序即 UI 展示顺序：
 *   summary → facts → themes → support → opposition → needs → findings(争议/情绪) →
 *   uncertainty → nextResearch
 *
 * ⚠️ 可验证性铁律（V3.0 第一性原理的落实点）：
 *   `zodToStrictJsonSchema()` 会把每个字段都变成 `required`（这是 Structured Outputs 的要求），
 *   而「每个字段都 required」就等于「每个字段都可以被模型填成空」——
 *   于是 `{"ok":1}` 这种与业务无关的合法 JSON 也会被 `.default([])` 补全成
 *   **一份全空的「成功分析」**。这恰恰是 V3.0 要消灭的「幽灵成功」。
 *
 *   因此这里加一条**领域可识别性**约束（superRefine）：
 *     - 结果不能是全空；
 *     - 至少要有 `summary` 或 `facts` 这类「通用骨架字段」；
 *     - 至少要有一个评论领域的领域字段（findings / themes / support / opposition /
 *       needs / questions / uncertainty / nextResearch）非空。
 *   不满足即判 `OUTPUT_SCHEMA_INVALID` → 进入（且仅进入一次）自动修复；
 *   修复仍不满足则如实失败，**绝不落 CommentAnalysis**。
 */
export const commentAIResultSchema = z.object({
  /** 1. 核心结论（一句话概括，不得包含未在下方出现的新事实） */
  summary: z.string().max(2000).default(''),

  /** 2. 客观事实：必须来自给定数据（factsJson / sample），不得编造数字 */
  facts: z.array(z.string().max(1000)).max(50).default([]),

  /** 3. 解释性发现（主题 / 痛点 / 情绪 / 争议 / 行为） */
  findings: z.array(findingSchema).max(50).default([]),

  /** 4. 主题 */
  themes: z.array(themeSchema).max(30).default([]),

  /** 5. 支持观点（必须引用真实 rpid） */
  support: z.array(citedClaimSchema).max(30).default([]),

  /** 6. 质疑 / 反对观点（必须引用真实 rpid） */
  opposition: z.array(citedClaimSchema).max(30).default([]),

  /** 7. 用户需求 */
  needs: z.array(z.string().max(1000)).max(30).default([]),

  /** 8. 高频问题 */
  questions: z.array(z.string().max(1000)).max(30).default([]),

  /** 9. 不确定性说明（必须写清样本量 / 清洗 / 抽样偏差 / 数据完整性） */
  uncertainty: z.array(z.string().max(1500)).max(30).default([]),

  /** 10. 下一步要采集什么数据（不得伪装成结论） */
  nextResearch: z.array(z.string().max(1000)).max(30).default([]),
})
  .superRefine((v, ctx) => {
    const hasAnyContent =
      v.summary.trim().length > 0 ||
      v.facts.length > 0 ||
      v.findings.length > 0 ||
      v.themes.length > 0 ||
      v.support.length > 0 ||
      v.opposition.length > 0 ||
      v.needs.length > 0 ||
      v.questions.length > 0 ||
      v.uncertainty.length > 0 ||
      v.nextResearch.length > 0;
    if (!hasAnyContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['<root>'],
        message: '所有字段均为空：这不是一份评论分析结果（拒绝把无关 JSON 当作成功分析）',
      });
      return;
    }

    // 通用骨架字段：至少要有 summary 或 facts（评论领域契约的入口）
    if (v.summary.trim().length === 0 && v.facts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'summary 与 facts 同时为空：缺少最基本的分析结论 / 事实',
      });
    }

    // 评论领域字段：至少一个非空，否则「看起来像 JSON，但不是评论分析」
    const domainSignals =
      v.findings.length +
      v.themes.length +
      v.support.length +
      v.opposition.length +
      v.needs.length +
      v.questions.length +
      v.uncertainty.length +
      v.nextResearch.length;
    if (domainSignals === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['<root>'],
        message:
          '缺少任何评论领域字段（findings/themes/support/opposition/needs/questions/uncertainty/nextResearch）',
      });
    }
  });
export type CommentAIResult = z.infer<typeof commentAIResultSchema>;

/**
 * 兜底 schema：Creator / Video 分析沿用 facts / explanations / uncertainty 三段结构。
 * 保留为独立 schema（它们不是「评论领域」），但同样要求可验证。
 *
 * 同样加「领域可识别性」约束：全空结果 = 失败，不得当作成功。
 */
export const generalAIResultSchema = z
  .object({
    summary: z.string().max(2000).default(''),
    facts: z.array(z.string().max(1000)).max(50).default([]),
    explanations: z.array(z.string().max(1500)).max(50).default([]),
    uncertainty: z.array(z.string().max(1500)).max(30).default([]),
    nextResearch: z.array(z.string().max(1000)).max(30).default([]),
  })
  .superRefine((v, ctx) => {
    const total =
      (v.summary.trim().length > 0 ? 1 : 0) +
      v.facts.length +
      v.explanations.length +
      v.uncertainty.length +
      v.nextResearch.length;
    if (total === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['<root>'],
        message: '所有字段均为空：这不是一份有效分析结果',
      });
    }
  });
export type GeneralAIResult = z.infer<typeof generalAIResultSchema>;

/** 领域注册表：一个领域 → 一份 schema */
export const DOMAIN_SCHEMAS = {
  comment: commentAIResultSchema,
  creator: generalAIResultSchema,
  video: generalAIResultSchema,
  idea: generalAIResultSchema,
} as const;

export type AIDomain = keyof typeof DOMAIN_SCHEMAS;

/**
 * 领域结构签名：该领域的**必填骨架字段**至少出现一个。
 *
 * 为什么需要它（V3.0 真实缺陷修复）：
 *   在 Structured Outputs 下所有字段都是 required，`zod.object` 也带 `.default()`，
 *   于是一个**与业务毫无关系的合法 JSON**（例如 `{"ok":1}`）会被 Zod 补全成
 *   「字段齐全、内容全空」的合法结果 —— 校验通过、被当成成功、落库、
 *   UI 显示一片空白。这就是「幽灵成功」。
 *
 *   本函数在 `validateAIResult` 里作为**前置结构签名检查**：
 *   连骨架字段都没有 → 直接判 OUTPUT_SCHEMA_INVALID（可修复），
 *   交给 orchestrator 走那**唯一一次**自动修复。
 */
const DOMAIN_SHAPE_KEYS: Record<AIDomain, readonly string[]> = {
  comment: [
    'summary',
    'facts',
    'findings',
    'themes',
    'support',
    'opposition',
    'needs',
    'questions',
    'uncertainty',
    'nextResearch',
  ],
  creator: ['summary', 'facts', 'explanations', 'uncertainty', 'nextResearch'],
  video: ['summary', 'facts', 'explanations', 'uncertainty', 'nextResearch'],
  idea: ['summary', 'facts', 'explanations', 'uncertainty', 'nextResearch'],
};

/**
 * 用 Zod 校验「已 parse 的 JSON 对象」。
 * 返回 discriminated union，调用方必须显式处理失败分支——
 * 不允许「校验失败就当作成功」。
 *
 * 两级校验：
 *   1. **结构签名**：值必须至少含一个该领域的骨架字段（挡掉无关 JSON）。
 *   2. **Zod 语义校验**：类型 / 长度 / 领域可识别性（挡掉全空与错误类型）。
 */
export type SchemaValidation =
  | { ok: true; data: CommentAIResult | GeneralAIResult }
  | { ok: false; error: string; issues: string[] };

export function validateAIResult(domain: AIDomain, value: unknown): SchemaValidation {
  // ── 第 1 级：结构签名（不是对象 / 不含任何领域骨架字段 → 形状不符） ──
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: 'OUTPUT_SCHEMA_INVALID',
      issues: [`<root>: 期望对象，收到 ${Array.isArray(value) ? 'array' : typeof value}`],
    };
  }
  const obj = value as Record<string, unknown>;
  const shapeKeys = DOMAIN_SHAPE_KEYS[domain];
  const matched = shapeKeys.filter((k) => k in obj);
  if (matched.length === 0) {
    return {
      ok: false,
      error: 'OUTPUT_SCHEMA_INVALID',
      issues: [
        `<root>: 缺少 ${domain} 领域的全部骨架字段（${shapeKeys.join(', ')}），` +
          `实际键：${Object.keys(obj).slice(0, 8).join(', ') || '（无）'}`,
      ],
    };
  }

  // ── 第 2 级：Zod 语义校验 ──
  const schema = DOMAIN_SCHEMAS[domain];
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  const issues = r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
  return { ok: false, error: 'OUTPUT_SCHEMA_INVALID', issues };
}

/**
 * 把模型可能返回的「包裹式」JSON 解包：
 * 有些模型会把结果放在 `{ result: {...} }` / `{ data: {...} }` / `{ analysis: {...} }` 里。
 * 只做一层解包，不做猜测式深挖。
 */
export function unwrapAIResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  for (const key of ['result', 'data', 'analysis']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      // 只有当外层缺少核心字段时才解包，避免误吞合法结构
      const hasCore = 'summary' in obj || 'facts' in obj || 'findings' in obj;
      if (!hasCore) return inner;
    }
  }
  return value;
}
