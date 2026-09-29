import { z } from 'zod';
import { isoString, nonEmpty } from './common';
import { commentAIResultSchema } from '../ai/schemas';

/**
 * 评论模型（V0.2 · P0-C 升级）。
 *
 * 关键变更（相对 V0.1）：
 *  - 优先保留字符串版 ID：`rpidStr` / `midStr`（B 站接口已提供 rpid_str / mid_str，
 *    用字符串保证大整数精度，不依赖 JS Number）。
 *  - 区分层级：`replyLevel`（1=一级 / 2=二级回复 / 3=更深）、`rootRpid`（根评论 rpid）、
 *    `parentRpid`（父评论 rpid）、`dialog`（对话根 rpid）。不再只用模糊的 `parentId`。
 *  - 字段扩展：`like` / `replyCount` / `ctime` / `uname` / `content` / `level`，
 *    以及可选 `sex` / `vipStatus` / `location`（接口稳定提供时保留）。
 *  - 来源标记 `source`：wbi-main（一级游标）/ reply（二级回复）/ hots（热门）/ manual。
 */

export const commentSchema = z.object({
  id: nonEmpty,
  videoId: nonEmpty,

  // —— 标识（字符串优先，保证精度；V0.2.1 起为 canonical key）——
  rpid: z.number().int().nonnegative(),
  rpidStr: z.string().min(1),
  mid: z.number().int().nonnegative(),
  midStr: z.string().min(1),

  // —— 层级关系（数字兼容字段）——
  rootRpid: z.number().int().nonnegative().default(0),
  parentRpid: z.number().int().nonnegative().default(0),
  dialog: z.number().int().nonnegative().default(0),
  replyLevel: z.number().int().min(1).max(3).default(1),

  // —— 层级关系（V0.2.1 · P1-8 字符串 canonical key，避免大整数精度丢失）——
  rootRpidStr: z.string().default(''),
  parentRpidStr: z.string().default(''),
  dialogStr: z.string().default(''),

  // —— 内容 / 互动 ——
  like: z.number().int().nonnegative().default(0),
  replyCount: z.number().int().nonnegative().default(0),
  ctime: z.number().int().nonnegative(),
  uname: z.string().max(64),
  content: z.string().max(8000),
  level: z.number().int().min(0).max(7).default(0),

  // —— 可选画像（接口稳定提供时才有；缺失 = undefined，UI 显示 –）——
  sex: z.string().max(8).optional(),
  vipStatus: z.number().int().optional(),
  location: z.string().max(64).optional(),

  // 结构化正文（emoji / @ 等），供将来扩展；字符串版存 content
  contentRaw: z.unknown().optional(),

  source: z.enum(['wbi-main', 'reply', 'hots', 'manual']).default('wbi-main'),

  createdAt: isoString,
  updatedAt: isoString,
});

export type Comment = z.infer<typeof commentSchema>;

/** 采集档位：快速 / 标准 / 深度 / 上限 */
export const commentTierEnum = z.enum(['quick', 'standard', 'deep', 'max']);
export type CommentTier = z.infer<typeof commentTierEnum>;

export const COMMENT_TIER_LIMIT: Record<CommentTier, number> = {
  quick: 50,
  standard: 200,
  deep: 500,
  max: 1000,
};

/** 评论排序：热度 / 时间 —— 对应 B 站 mode=3 / mode=2 */
export type CommentSort = 'hot' | 'time';

/** 采集深度：仅一级 / 深度（展开前 30 个一级的二级回复）/ 高级（前 100 个） */
export type CommentDepth = 'top' | 'deep' | 'advanced';

export const commentAnalysisSchema = z.object({
  id: nonEmpty,
  videoId: nonEmpty,
  createdAt: isoString,
  model: z.string().min(1),
  /**
   * V3.2.0 · AI-META：本次分析 Main 请求的审计行（AIAnalysis.id）。
   * UI refresh 后经 auditId 关联审计行，恢复真实 durationMs / requestCount /
   * repaired / tokens / finishReason / provider —— 修复「refresh 后 0ms / 0 次请求」。
   * 旧记录（V3.1.x 及更早）无此字段 → optional，UI 如实降级显示，绝不硬编码 0 冒充真实值。
   */
  auditId: z.string().min(1).optional(),
  // 统计事实（与 AI 推断分离）
  factSummary: z.string().max(10_000).default(''),
  themeResult: z.array(z.string()).default([]),
  sentimentResult: z
    .object({
      positive: z.number().int().nonnegative().default(0),
      neutral: z.number().int().nonnegative().default(0),
      negative: z.number().int().nonnegative().default(0),
    })
    .default({ positive: 0, neutral: 0, negative: 0 }),
  userNeedResult: z.array(z.string()).default([]),
  questionResult: z.array(z.string()).default([]),
  supportResult: z.array(z.string()).default([]),
  oppositionResult: z.array(z.string()).default([]),
  // 支持 / 质疑必须附带原始评论引用（禁止凭空断言；存真实 rpidStr，仅本地）
  citedCommentRpids: z.array(z.string()).default([]),
  /**
   * V3.1.0 · P0-AI 隐私化：匿名引用映射（ref → 真实 rpidStr）。
   *
   * 「真实 ID 留在本地，所有引用可回溯，所有 AI 结果可审计。」
   * - AI 请求里只见 C001 类 ref（sample / facts / schema 全匿名）；
   * - 本映射随产品结果落库，UI 用它把 AI 结果中的 ref 回溯到真实评论；
   * - 绝不发送 Provider，也绝不进入 prompt / 审计 prompt 字段；
   * - 旧记录无此字段 → default({})，回溯不可用时 UI 如实降级（显示 ref 本身）。
   */
  citationMap: z.record(z.string()).default({}),
  uncertaintyNote: z.string().max(5000).default(''),
  /**
   * Provider 原始响应（`AnalyzeResponse.raw`），**仅供审计/排错**。
   * ⚠️ 语义铁律：这里**不是**结构化业务结果，UI 不得把它当 `CommentAIResult` 使用。
   */
  rawResponse: z.unknown().optional(),
  /**
   * V3.0.1 · P0-2：通过 Zod 校验的**结构化业务结果**（`CommentAIResult`）。
   *
   * 为什么必须新增这一列：
   * V3.0.0 把 `rawResponse`（Provider 原始响应，形如 `{choices:[...]}`）当成产品结果，
   * UI 又把它强转成 `CommentAIResult` 消费 —— 语义完全错位，
   * 且 AI 成功后 `refresh()` 会再读一次，把内存里正确的 report 覆盖成错位的原始响应。
   *
   * 兼容性：V3.0.0 之前写入的旧记录没有本字段 → 读取端必须显示
   * 「该分析为旧版本记录，未保存结构化产品结果，请重新分析」，**不得猜测、不得回退**。
   *
   * 类型用 `.optional()` 而非 `.default(...)`：旧记录必须能被**读出来**（而不是被默认值补全成
   * 一个假的结构化结果），由 UI 显式区分「有结构化结果」与「旧版本记录」。
   */
  analysisResult: commentAIResultSchema.optional(),
});

export type CommentAnalysis = z.infer<typeof commentAnalysisSchema>;
