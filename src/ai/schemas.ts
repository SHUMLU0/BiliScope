/**
 * AI 结果统一 Schema（V3.2.0 · Comment Research Analyst）。
 *
 * ⚠️ 第一性原理（V3.0 起强制，V3.2.0 继承）：
 *   **AI 输出必须是「可验证的数据」，不是「一段字符串」。**
 *   禁止把 `JSON.parse(text)` 成功当作分析成功——那只能证明「模型吐出了合法 JSON」，
 *   不能证明「结果符合 BiliScope 的业务契约」。
 *
 * V3.2.0 升级（Comment Summarizer → Comment Research Analyst）：
 *   V3.0/V3.1 的输出是「事实整理 + 主题分类 + 支持/反对」——像高级筛选器，
 *   没有回答「这批评论真正意味着什么」。V3.2.0 把产品结果重构为**研究判断**：
 *
 *   - `relevantFacts`（≤5）取代 `facts`：只保留对后续判断真正有用的原始事实，
 *     禁止复述 UI 统计区已展示的数字（总评论数 / 时间跨度 / 最高赞等）。
 *   - `narratives`：评论区结构（主叙事 / 次叙事 / 反叙事）。
 *   - `audienceSegments`：用户群体分群（含样本不足时的诚实处理）。
 *   - `tensions`：核心矛盾（对立双方 + 引用）。
 *   - `mechanisms`：可能机制（hypothesis + explanation + evidence + confidence），
 *     禁止写成确定因果。
 *   - `signalVsNoise`：信号 / 噪声区分（每条必须给 reason）。
 *   - `contentImplications`：这条内容真正提供了什么价值（信息/情绪/身份认同/对比…）。
 *   - `claims`：带置信度的关键判断。
 *   - `hypothesesToTest`：假设 → 支持证据 → 反证 → 缺失证据 → 验证方法（研究工具核心）。
 *
 *   旧分类字段（facts / findings / themes / support / opposition）从 AI 输出契约中**移除**：
 *   它们是「高级复述」，消耗 token 却不产生判断。旧记录（V3.1.x 落库的 analysisResult）
 *   在 UI 端按遗留数据防御性展示（见 CommentAIReport「原始分析」区）。
 *
 * 设计约束（不变）：
 *  1. **一个领域 = 一份 schema，一处定义，所有 Provider 共用**。
 *  2. 引用必须落到匿名 ref：所有判断字段的 refs 都使用 C001 样式匿名引用
 *     （AI 永远看不到真实 rpid / mid / uname / uid / videoId）。
 *  3. `uncertainty` 必须说明「哪些无法确认」。
 *  4. 质量优先于字段填满率：没有足够证据时数组必须为空，禁止硬凑。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────── 置信度与引用基元

/** 判断置信度：机制 / 判断 / 假设通用 */
export const confidenceEnum = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof confidenceEnum>;

// ─────────────────────────────────────────────────────────── 评论区结构（叙事）

/** 叙事角色：primary=主叙事 / secondary=次叙事 / counter=反叙事 */
export const narrativeRoleEnum = z.enum(['primary', 'secondary', 'counter']);
export type NarrativeRole = z.infer<typeof narrativeRoleEnum>;

/**
 * 评论区叙事（V3.2.0 核心）。
 * `refs` = 支撑该叙事的匿名评论引用；样本不足时允许为空数组（UI 显式标注「无引用」）。
 */
export const narrativeSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1500),
  role: narrativeRoleEnum,
  refs: z.array(z.string().min(1)).max(100).default([]),
});
export type Narrative = z.infer<typeof narrativeSchema>;

// ─────────────────────────────────────────────────────────── 用户分群

/**
 * 用户群体（V3.2.0 核心）。
 * 区分情绪参与者 / 反叙事参与者 / 信息求证者 / 实用信息需求者 / 比较型用户 / 玩梗用户等。
 * 样本无法可靠区分该群体时，AI 必须在 description 里如实说明（禁止强行编造）。
 */
export const audienceSegmentSchema = z.object({
  name: z.string().min(1).max(200),
  need: z.string().min(1).max(1000),
  behavior: z.string().min(1).max(1000),
  refs: z.array(z.string().min(1)).max(100).default([]),
});
export type AudienceSegment = z.infer<typeof audienceSegmentSchema>;

// ─────────────────────────────────────────────────────────── 核心矛盾

/**
 * 核心矛盾（V3.2.0 核心）：不是「支持 vs 反对」的分类，而是观点之间真正的冲突结构。
 * 至少一侧应有证据支撑（UI 对双空引用的矛盾显式标注）。
 */
export const tensionSchema = z.object({
  statement: z.string().min(1).max(1000),
  sideA: z.string().min(1).max(1000),
  sideB: z.string().min(1).max(1000),
  refs: z.array(z.string().min(1)).max(100).default([]),
});
export type Tension = z.infer<typeof tensionSchema>;

// ─────────────────────────────────────────────────────────── 可能机制

/**
 * 可能机制（V3.2.0 核心）。
 * ⚠️ 因果纪律：这是「可能机制」，不是确定因果 —— 当前数据没有实验设计证明因果。
 * 禁止「该视频导致用户认为 X」式断言；用「可能是互动放大器之一」式措辞。
 */
export const mechanismSchema = z.object({
  hypothesis: z.string().min(1).max(1000),
  explanation: z.string().min(1).max(2000),
  evidenceRefs: z.array(z.string().min(1)).max(50).default([]),
  confidence: confidenceEnum,
});
export type Mechanism = z.infer<typeof mechanismSchema>;

// ─────────────────────────────────────────────────────────── 信号 / 噪声

/** signal=提供新事实或逻辑的评论；noise=纯情绪表态 / 玩梗 */
export const signalNoiseTypeEnum = z.enum(['signal', 'noise']);
export type SignalNoiseType = z.infer<typeof signalNoiseTypeEnum>;

/**
 * 信号 / 噪声（V3.2.0 核心）。
 * `reason` 必填：每条判定都必须解释「为什么这是信号 / 噪声」，否则不构成研究判断。
 */
export const signalNoiseSchema = z.object({
  type: signalNoiseTypeEnum,
  statement: z.string().min(1).max(1000),
  reason: z.string().min(1).max(1500),
  refs: z.array(z.string().min(1)).max(50).default([]),
});
export type SignalNoise = z.infer<typeof signalNoiseSchema>;

// ─────────────────────────────────────────────────────────── 内容价值

/**
 * 内容含义（V3.2.0 核心）：这条内容真正提供了什么（信息 / 情绪 / 身份认同 / 对比 / 冲突 /
 * 讨论空间 / 实用信息），以及这对内容研究意味着什么。禁止营销鸡汤。
 */
export const contentImplicationSchema = z.object({
  insight: z.string().min(1).max(1000),
  basisRefs: z.array(z.string().min(1)).max(50).default([]),
  implication: z.string().min(1).max(1500),
});
export type ContentImplication = z.infer<typeof contentImplicationSchema>;

// ─────────────────────────────────────────────────────────── 带置信度的判断

/**
 * 关键判断（V3.2.0）：可独立阅读的研究结论，必须带置信度与匿名引用。
 */
export const confidenceClaimSchema = z.object({
  statement: z.string().min(1).max(1000),
  refs: z.array(z.string().min(1)).max(50).default([]),
  confidence: confidenceEnum,
});
export type ConfidenceClaim = z.infer<typeof confidenceClaimSchema>;

// ─────────────────────────────────────────────────────────── 可验证假设

/**
 * 可验证假设（V3.2.0 核心，研究工具闭环）：
 *   假设 → 支持证据 → 反证 → 目前缺失的证据 → 验证方法。
 * 不是「下一步继续采集评论」，而是可执行的实验设计。
 */
export const hypothesisToTestSchema = z.object({
  hypothesis: z.string().min(1).max(1000),
  evidenceForRefs: z.array(z.string().min(1)).max(50).default([]),
  evidenceAgainstRefs: z.array(z.string().min(1)).max(50).default([]),
  missingEvidence: z.array(z.string().max(500)).max(20).default([]),
  testMethod: z.string().min(1).max(1500),
});
export type HypothesisToTest = z.infer<typeof hypothesisToTestSchema>;

// ─────────────────────────────────────────────────────────── 评论领域结果（V3.2.0 唯一真相）

/**
 * 评论分析的领域结果（V3.2.0 唯一真相）。
 *
 * 字段顺序即 UI 展示顺序：
 *   summary → relevantFacts → narratives → tensions → audienceSegments → mechanisms →
 *   signalVsNoise → contentImplications → claims → needs/questions →
 *   hypothesesToTest → uncertainty → nextResearch
 *
 * ⚠️ 可验证性铁律（V3.0 起的「反幽灵成功」防线，V3.2.0 继续生效）：
 *   `zodToStrictJsonSchema()` 会把每个字段都变成 `required`，而 `.default([])`
 *   会把无关 JSON 补成全空「成功」。因此 superRefine 强制：
 *     - 结果不能全空；
 *     - **必须至少产生一个研究判断字段**（narratives / tensions / mechanisms /
 *       signalVsNoise / contentImplications / claims / hypothesesToTest 非空）——
 *       只输出事实复述（relevantFacts + summary）= Summarizer 行为 = 拒绝
 *       （AI-RESEARCH-001 / 002 的 schema 化落实）。
 *   不满足即判 `OUTPUT_SCHEMA_INVALID` → 进入（且仅进入一次）自动修复；
 *   修复仍不满足则如实失败，**绝不落 CommentAnalysis**。
 */
export const commentAIResultSchema = z.object({
  /** 1. 核心判断：AI 对这批评论真正得出的结论（不是内容概要） */
  summary: z.string().max(2000).default(''),

  /** 2. 相关事实（≤5）：只保留对后续判断真正有用的原始事实，禁止复述 UI 统计区已有数字 */
  relevantFacts: z.array(z.string().max(1000)).max(5).default([]),

  /** 3. 评论区结构：主叙事 / 次叙事 / 反叙事 */
  narratives: z.array(narrativeSchema).max(6).default([]),

  /** 4. 用户群体分群 */
  audienceSegments: z.array(audienceSegmentSchema).max(5).default([]),

  /** 5. 核心矛盾（观点间真正的冲突结构） */
  tensions: z.array(tensionSchema).max(5).default([]),

  /** 6. 可能机制（禁止确定因果措辞） */
  mechanisms: z.array(mechanismSchema).max(5).default([]),

  /** 7. 信号 / 噪声（每条必带 reason） */
  signalVsNoise: z.array(signalNoiseSchema).max(8).default([]),

  /** 8. 对内容研究意味着什么 */
  contentImplications: z.array(contentImplicationSchema).max(5).default([]),

  /** 9. 关键判断（带置信度） */
  claims: z.array(confidenceClaimSchema).max(8).default([]),

  /** 10. 用户需求 */
  needs: z.array(z.string().max(1000)).max(30).default([]),

  /** 11. 高频问题 */
  questions: z.array(z.string().max(1000)).max(30).default([]),

  /** 12. 不确定性说明（样本量 / 清洗 / 抽样偏差 / 数据完整性） */
  uncertainty: z.array(z.string().max(1500)).max(30).default([]),

  /** 13. 可验证假设（假设 → 证据 → 反证 → 缺失 → 验证方法） */
  hypothesesToTest: z.array(hypothesisToTestSchema).max(5).default([]),

  /** 14. 下一步要采集什么数据（不得伪装成结论） */
  nextResearch: z.array(z.string().max(1000)).max(30).default([]),
})
  .superRefine((v, ctx) => {
    // ── 1) 全空拒绝（反幽灵成功第一道） ──
    const hasAnyContent =
      v.summary.trim().length > 0 ||
      v.relevantFacts.length > 0 ||
      v.narratives.length > 0 ||
      v.audienceSegments.length > 0 ||
      v.tensions.length > 0 ||
      v.mechanisms.length > 0 ||
      v.signalVsNoise.length > 0 ||
      v.contentImplications.length > 0 ||
      v.claims.length > 0 ||
      v.needs.length > 0 ||
      v.questions.length > 0 ||
      v.uncertainty.length > 0 ||
      v.hypothesesToTest.length > 0 ||
      v.nextResearch.length > 0;
    if (!hasAnyContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['<root>'],
        message: '所有字段均为空：这不是一份评论分析结果（拒绝把无关 JSON 当作成功分析）',
      });
      return;
    }

    // ── 2) 通用骨架：summary 或 relevantFacts 至少一个非空 ──
    if (v.summary.trim().length === 0 && v.relevantFacts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'summary 与 relevantFacts 同时为空：缺少最基本的分析结论 / 事实',
      });
    }

    // ── 3) Research Analyst 铁律：必须至少产生一个研究判断 ──
    // 只输出事实复述 / 分类 = Comment Summarizer 行为，不是 Analyst 输出。
    // （AI-RESEARCH-001 / AI-RESEARCH-002 的 schema 化落实）
    const researchSignals =
      v.narratives.length +
      v.tensions.length +
      v.mechanisms.length +
      v.signalVsNoise.length +
      v.contentImplications.length +
      v.claims.length +
      v.hypothesesToTest.length;
    if (researchSignals === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['<root>'],
        message:
          '没有任何研究判断字段（narratives/tensions/mechanisms/signalVsNoise/contentImplications/claims/hypothesesToTest）：' +
          '这是事实复述，不是研究分析 —— 拒绝',
      });
    }
  });
export type CommentAIResult = z.infer<typeof commentAIResultSchema>;

/**
 * 遍历结果中**所有引用数组**（refs / evidenceRefs / basisRefs / evidenceForRefs / evidenceAgainstRefs）。
 * 引用审计（orchestrator）与 UI 引用高亮（comment-page）共用，保证两端口径一致。
 */
export function forEachResultRefs(data: CommentAIResult, cb: (refs: string[]) => void): void {
  for (const n of data.narratives) cb(n.refs);
  for (const s of data.audienceSegments) cb(s.refs);
  for (const t of data.tensions) cb(t.refs);
  for (const m of data.mechanisms) cb(m.evidenceRefs);
  for (const s of data.signalVsNoise) cb(s.refs);
  for (const c of data.contentImplications) cb(c.basisRefs);
  for (const c of data.claims) cb(c.refs);
  for (const h of data.hypothesesToTest) {
    cb(h.evidenceForRefs);
    cb(h.evidenceAgainstRefs);
  }
}

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
 * 为什么需要它（V3.0 真实缺陷修复，V3.2.0 继续生效）：
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
    'relevantFacts',
    'narratives',
    'audienceSegments',
    'tensions',
    'mechanisms',
    'signalVsNoise',
    'contentImplications',
    'claims',
    'needs',
    'questions',
    'uncertainty',
    'hypothesesToTest',
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
      const hasCore =
        'summary' in obj || 'relevantFacts' in obj || 'narratives' in obj || 'facts' in obj;
      if (!hasCore) return inner;
    }
  }
  return value;
}
