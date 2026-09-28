/**
 * 评论 AI 分析的数据准备层（V0.2 · P0-F · Group F）。
 *
 * 流水线：采集结果 → 清洗 → 去重 → **统计事实** → 构建 AI 上下文 → （交给适配器）AI 推断。
 *
 * 关键原则（用户强制要求）：
 *  1. **统计事实与 AI 推断严格分离**：本模块只产出可复核的数字与样本，
 *     AI 只接收这些事实 + 抽样原文，返回 facts / explanations / uncertainty。
 *  2. 支持 / 反对观点必须能引用原始评论 ID（`citedCommentRpids`），禁止凭空断言。
 *  3. 绝不用 0 伪装缺失；拿不到就是 null。
 */

import type { Comment } from '@models/comment';
import { computeCommentStats, countKeywords, topComments, type CommentStats } from './analytics';

export interface CommentPrepOptions {
  /** 送入 AI 的样本上限（默认 120，避免超长上下文） */
  sampleLimit?: number;
  /** 每条正文截断长度（默认 300） */
  contentLimit?: number;
  /** 清洗：过滤字数过短（默认 <2 字）的评论 */
  minContentLen?: number;
}

export interface CleanComment {
  rpidStr: string;
  uname: string;
  content: string;
  like: number;
  replyLevel: number;
  ctime: number;
}

export interface CommentAnalysisInput {
  /** 客观统计事实（与 AI 推断分离） */
  stats: CommentStats;
  /** 高频关键词（客观计数） */
  keywords: { keyword: string; count: number }[];
  /** 高赞评论（客观排序） */
  topComments: CleanComment[];
  /** 送给 AI 的抽样正文（去重、清洗后） */
  sample: CleanComment[];
  /** 参与分析的评论总数 */
  total: number;
  /** 被清洗掉的条数（过短 / 重复 / 正文为空） */
  droppedCount: number;
  /** 说明文本（供 UI 展示，强调「事实在前、推断在后」） */
  note: string;
}

const DEFAULT_MIN_LEN = 2;

/** 清洗：去空白、丢空正文、丢过短 */
function cleanOne(c: Comment, minLen: number): CleanComment | null {
  const content = c.content.replace(/\s+/g, ' ').trim();
  if (content.length < minLen) return null;
  return {
    rpidStr: c.rpidStr,
    uname: c.uname,
    content,
    like: c.like,
    replyLevel: c.replyLevel,
    ctime: c.ctime,
  };
}

/**
 * 去重：同一 rpidStr 只保留一条；正文完全相同且同一用户（刷屏）也只保留一条。
 */
function dedupe(list: CleanComment[]): CleanComment[] {
  const byRpid = new Set<string>();
  const byContent = new Set<string>();
  const out: CleanComment[] = [];
  for (const c of list) {
    if (byRpid.has(c.rpidStr)) continue;
    const contentKey = `${c.uname}#${c.content}`;
    if (byContent.has(contentKey)) continue;
    byRpid.add(c.rpidStr);
    byContent.add(contentKey);
    out.push(c);
  }
  return out;
}

/**
 * 构建评论分析输入：清洗 → 去重 → 统计 → 抽样。
 * 返回的 `stats` / `keywords` / `topComments` 是**事实**，`sample` 是喂给 AI 的原料。
 */
export function prepareCommentAnalysis(
  comments: Comment[],
  opts: CommentPrepOptions = {},
): CommentAnalysisInput {
  const minLen = opts.minContentLen ?? DEFAULT_MIN_LEN;
  const sampleLimit = opts.sampleLimit ?? 120;
  const contentLimit = opts.contentLimit ?? 300;

  const cleaned: CleanComment[] = [];
  for (const c of comments) {
    const one = cleanOne(c, minLen);
    if (one) cleaned.push(one);
  }
  const deduped = dedupe(cleaned);
  const droppedCount = comments.length - deduped.length;

  // 事实层：用原始 comments 计算统计（保留完整样本，不受清洗影响）
  // 但关键词 / 高赞用清洗后的集合，避免刷屏噪声。
  const stats = computeCommentStats(comments);
  const factsForKeywords: Comment[] = deduped.map((c) => ({
    id: c.rpidStr,
    videoId: '',
    rpid: Number(c.rpidStr) || 0,
    rpidStr: c.rpidStr,
    mid: 0,
    midStr: '',
    rootRpid: 0,
    parentRpid: 0,
    dialog: 0,
    replyLevel: c.replyLevel as 1 | 2 | 3,
    like: c.like,
    replyCount: 0,
    ctime: c.ctime,
    uname: c.uname,
    content: c.content,
    level: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    source: 'wbi-main',
  }));
  const keywords = countKeywords(factsForKeywords, { topN: 30 });
  const top = topComments(factsForKeywords, 15).map((c) => ({
    rpidStr: c.rpidStr,
    uname: c.uname,
    content: c.content,
    like: c.like,
    replyLevel: c.replyLevel,
    ctime: c.ctime,
  }));

  // 抽样：优先高赞 + 最新，保证 AI 看到代表性样本
  const forSample = [...deduped].sort((a, b) => b.like - a.like || b.ctime - a.ctime);
  const sample = forSample.slice(0, sampleLimit).map((c) => ({
    ...c,
    content: c.content.slice(0, contentLimit),
  }));

  return {
    stats,
    keywords,
    topComments: top,
    sample,
    total: comments.length,
    droppedCount,
    note: '统计数字为客观计算（不含 AI 推断）；AI 仅基于下方抽样原文产出解释性结论。',
  };
}

/**
 * 把「统计事实」序列化为给 AI 的事实块（JSON 字符串）。
 * 与 sample 分开传入，让 prompt 明确「事实」与「待解释样本」是两回事。
 */
export function serializeCommentFacts(input: CommentAnalysisInput): string {
  return JSON.stringify(
    {
      totalCollected: input.total,
      stats: {
        total: input.stats.total,
        topLevel: input.stats.topLevel,
        subReplies: input.stats.subReplies,
        avgLikeTopLevel: input.stats.avgLikeTopLevel,
        maxLike: input.stats.maxLike,
        replyRate: input.stats.replyRate,
        spanFrom: input.stats.earliestCtime,
        spanTo: input.stats.latestCtime,
        uniqueUsers: input.stats.uniqueUsers,
      },
      keywords: input.keywords.slice(0, 20),
      topComments: input.topComments.map((c) => ({ rpid: c.rpidStr, like: c.like, excerpt: c.content.slice(0, 120) })),
      droppedNoisy: input.droppedCount,
    },
    null,
    2,
  );
}
