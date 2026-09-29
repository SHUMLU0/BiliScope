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
import { computeCommentStats, countKeywords, type CommentStats } from './analytics';

/**
 * V3.0.1 · P0-1：AI 样本抽样策略。
 *
 * 铁律：**样本只影响 AI 输入，绝不影响统计事实。**
 * 采集多少条 → 统计就是多少条；AI 只看受控样本。
 */
export type CommentSampleStrategy = 'hot' | 'latest' | 'diverse';

export const SAMPLE_STRATEGY_LABEL: Record<CommentSampleStrategy, string> = {
  hot: '高赞样本',
  latest: '最新样本',
  diverse: '多样性样本',
};

export interface CommentPrepOptions {
  /** 送入 AI 的样本上限（默认 120，避免超长上下文） */
  sampleLimit?: number;
  /** 每条正文截断长度（默认 300） */
  contentLimit?: number;
  /** 清洗：过滤字数过短（默认 <2 字）的评论 */
  minContentLen?: number;
  /**
   * V3.0.1 · P0-1：抽样策略（默认 `hot` = 高赞优先，与 V3.0 行为一致）。
   * - `hot`     高赞优先，同赞按时间新者优先
   * - `latest`  时间新者优先
   * - `diverse` 分层（按点赞分位）轮转抽取，避免只看头部
   */
  sampleStrategy?: CommentSampleStrategy;
}

export interface CleanComment {
  rpidStr: string;
  uname: string;
  content: string;
  like: number;
  replyCount: number;
  replyLevel: number;
  ctime: number;
}

/**
 * V3.1.0 · P0-AI 隐私化：喂给 AI 的**匿名**样本条目。
 *
 * 铁律：本类型**禁止**出现 videoId / rpid / mid / midStr / uname / uid ——
 * AI 只见 `ref`（C001 起始的匿名引用），真实 rpid 只留在本地 `citationMap`。
 * 「真实 ID 留在本地，所有引用可回溯，所有 AI 结果可审计。」
 */
export interface SampleComment {
  /** 匿名引用（C001 起始，3 位补零） */
  ref: string;
  content: string;
  likes: number;
  replyCount: number;
  replyLevel: number;
  /** 为什么这条被选入样本（来自抽样策略标签） */
  selectionReason: string;
  /** 在样本中的序号（1 起） */
  rankInSample: number;
}

/** V3.1.0 · P0-AI 隐私化：事实块里的高赞评论（匿名 ref 投影） */
export interface TopCommentRef {
  ref: string;
  likes: number;
  excerpt: string;
}

export interface CommentAnalysisInput {
  /** 客观统计事实（与 AI 推断分离） */
  stats: CommentStats;
  /** 高频关键词（客观计数） */
  keywords: { keyword: string; count: number }[];
  /** 高赞评论（客观排序；V3.1.0 起为匿名 ref 投影，且**只从 sample 内**选取） */
  topComments: TopCommentRef[];
  /** 送给 AI 的抽样正文（去重、清洗、截断、**匿名化**后） */
  sample: SampleComment[];
  /** 参与分析的评论总数（= 统计基数，采样前） */
  total: number;
  /** 被清洗掉的条数（过短 / 重复 / 正文为空） */
  droppedCount: number;
  /** V3.0.1 · P0-1：实际使用的抽样策略 */
  sampleStrategy: CommentSampleStrategy;
  /** V3.0.1 · P0-1：AI 输入预算估算（字符级，非精确 tokenizer） */
  budget: CommentInputBudget;
  /**
   * V3.1.0 · P0-AI 隐私化：ref → 真实 rpidStr 的**本地**映射。
   * ⚠️ 绝不发送 Provider；随 CommentAnalysis 落库供 UI 回溯定位。
   */
  citationMap: Record<string, string>;
  /** 说明文本（供 UI 展示，强调「事实在前、推断在后」） */
  note: string;
}

/** V3.0.1 · P0-1：AI 输入体积估算（供 UI 提示，避免用户「不知道为什么慢」） */
export interface CommentInputBudget {
  /**
   * V3.0.1 · P1：**统计基数**（全部已采集评论数）。
   * 与 `sampleCount` 严格分区：统计采多少算多少，AI 只看受控样本。
   */
  total: number;
  /** AI 样本条数 */
  sampleCount: number;
  /** 样本正文字符数合计 */
  sampleChars: number;
  /** 事实块（factsJson）字符数 */
  factsChars: number;
  /** 估算总字符数（样本 + 事实；不含 system prompt） */
  totalChars: number;
  /** 是否超过建议安全阈值（超过时建议减少样本） */
  overBudget: boolean;
}

/** V3.0.1 · P0-1：AI 输入安全阈值（字符）。超过时 UI 提示并建议降低样本量。 */
export const AI_INPUT_SAFE_CHARS = 120_000;
/** 默认样本上限（V3.0.1 起为唯一采样上限来源） */
export const DEFAULT_SAMPLE_LIMIT = 120;

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
    replyCount: c.replyCount,
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
 * V3.0.1 · P0-1：按策略产出「受控代表性样本」。
 *
 * 这是**唯一**允许决定 AI 看多少条评论的地方。
 * prompt 构造器不得再做任何 slice。
 */
function buildSample(
  deduped: CleanComment[],
  limit: number,
  strategy: CommentSampleStrategy,
): CleanComment[] {
  if (limit <= 0 || deduped.length === 0) return [];

  if (strategy === 'latest') {
    return [...deduped].sort((a, b) => b.ctime - a.ctime || b.like - a.like).slice(0, limit);
  }

  if (strategy === 'diverse') {
    // 分层轮转：按点赞降序分成 limit 个分位，各取头部再轮转，避免样本全是头部高赞。
    const sorted = [...deduped].sort((a, b) => b.like - a.like || b.ctime - a.ctime);
    const buckets: CleanComment[][] = Array.from({ length: limit }, () => []);
    sorted.forEach((c, i) => {
      buckets[Math.min(limit - 1, Math.floor((i * limit) / sorted.length))]!.push(c);
    });
    const out: CleanComment[] = [];
    // 轮转抽取：每轮从每个分位取 1 条（分位内按赞降序）
    let round = 0;
    while (out.length < limit && round < sorted.length) {
      for (const b of buckets) {
        const item = b[round];
        if (item) {
          out.push(item);
          if (out.length >= limit) break;
        }
      }
      round += 1;
    }
    return out;
  }

  // 默认 hot：高赞优先，同赞按时间新的优先
  return [...deduped].sort((a, b) => b.like - a.like || b.ctime - a.ctime).slice(0, limit);
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
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const contentLimit = opts.contentLimit ?? 300;
  const sampleStrategy = opts.sampleStrategy ?? 'hot';

  const cleaned: CleanComment[] = [];
  for (const c of comments) {
    const one = cleanOne(c, minLen);
    if (one) cleaned.push(one);
  }
  const deduped = dedupe(cleaned);
  const droppedCount = comments.length - deduped.length;

  // 事实层：用原始 comments 计算统计（保留完整样本，不受清洗影响）
  // 但关键词用清洗后的集合，避免刷屏噪声。
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
    rootRpidStr: '',
    parentRpidStr: '',
    dialogStr: '',
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

  // 抽样：唯一采样入口（V3.0.1 · P0-1），prompt 层不得再 slice
  const picked = buildSample(deduped, sampleLimit, sampleStrategy);

  // ── V3.1.0 · P0-AI 隐私化：匿名 ref 分配（C001 起始）+ 本地 citationMap ──
  // ref → 真实 rpid 的映射**只留在本地**，绝不进入 prompt / facts / 审计 prompt 字段。
  const citationMap: Record<string, string> = {};
  const sample: SampleComment[] = picked.map((c, i) => {
    const ref = `C${String(i + 1).padStart(3, '0')}`;
    citationMap[ref] = c.rpidStr;
    return {
      ref,
      content: c.content.slice(0, contentLimit),
      likes: c.like,
      replyCount: c.replyCount,
      replyLevel: c.replyLevel,
      selectionReason: SAMPLE_STRATEGY_LABEL[sampleStrategy],
      rankInSample: i + 1,
    };
  });

  // 高赞事实：**只从 sample 内**选取 —— 保证每个 topComment 都有合法 ref 可回溯
  //（AI 只能引用它真正看到的 ref；样本外高赞的 rpid 不给 AI，也不伪装成可引用项）。
  const topComments: TopCommentRef[] = [...sample]
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 15)
    .map((s) => ({ ref: s.ref, likes: s.likes, excerpt: s.content.slice(0, 120) }));

  const factsJson = serializeCommentFacts({
    stats,
    keywords,
    topComments,
    total: comments.length,
    droppedCount,
  });

  const sampleChars = sample.reduce((n, c) => n + c.content.length + c.ref.length + 24, 0);
  const budget: CommentInputBudget = {
    // 统计基数（全部采集）与 AI 样本严格分区
    total: comments.length,
    sampleCount: sample.length,
    sampleChars,
    factsChars: factsJson.length,
    totalChars: sampleChars + factsJson.length,
    overBudget: sampleChars + factsJson.length > AI_INPUT_SAFE_CHARS,
  };

  return {
    stats,
    keywords,
    topComments,
    sample,
    total: comments.length,
    droppedCount,
    sampleStrategy,
    budget,
    citationMap,
    note: '统计数字为客观计算（不含 AI 推断）；AI 仅基于受控抽样原文产出解释性结论。样本以匿名引用（C001…）提供给模型，真实评论 ID 只保留在本地。',
  };
}

/** serializeCommentFacts 只需事实层字段，不需要 sample / budget（避免先有鸡后有蛋） */
export type CommentFactsInput = Pick<
  CommentAnalysisInput,
  'stats' | 'keywords' | 'topComments' | 'total' | 'droppedCount'
>;

/**
 * 把「统计事实」序列化为给 AI 的事实块（JSON 字符串）。
 * 与 sample 分开传入，让 prompt 明确「事实」与「待解释样本」是两回事。
 */
export function serializeCommentFacts(input: CommentFactsInput): string {
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
      // V3.1.0 · P0-AI 隐私化：高赞事实只带匿名 ref（{ref, likes, excerpt}），绝不出现 rpid / uname
      topComments: input.topComments.map((c) => ({ ref: c.ref, likes: c.likes, excerpt: c.excerpt })),
      droppedNoisy: input.droppedCount,
    },
    null,
    2,
  );
}
