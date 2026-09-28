import { z } from 'zod';
import { isoString, nonEmpty } from './common';

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

  // —— 标识（字符串优先，保证精度）——
  rpid: z.number().int().nonnegative(),
  rpidStr: z.string().min(1),
  mid: z.number().int().nonnegative(),
  midStr: z.string().min(1),

  // —— 层级关系 ——
  rootRpid: z.number().int().nonnegative().default(0),
  parentRpid: z.number().int().nonnegative().default(0),
  dialog: z.number().int().nonnegative().default(0),
  replyLevel: z.number().int().min(1).max(3).default(1),

  // —— 内容 / 互动 ——
  like: z.number().int().nonnegative().default(0),
  replyCount: z.number().int().nonnegative().default(0),
  ctime: z.number().int().nonnegative(),
  uname: z.string().max(64),
  content: z.string().max(8000),
  level: z.number().int().min(0).max(7).default(0),

  // —— 可选画像（接口稳定提供时才有）——
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
  // 支持 / 质疑必须附带原始评论引用 ID（禁止凭空断言）
  citedCommentRpids: z.array(z.string()).default([]),
  uncertaintyNote: z.string().max(5000).default(''),
  rawResponse: z.unknown().optional(),
});

export type CommentAnalysis = z.infer<typeof commentAnalysisSchema>;
