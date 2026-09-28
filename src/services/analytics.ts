/**
 * 数据分析层（V0.2 · P1 · Group B / D）。
 *
 * 纯函数：不碰网络、不碰 Dexie，输入模型数组 → 输出统计事实。
 * 明确区分「统计事实」（这里算出来的）与「AI 推断」（services/analysis 交给适配器）：
 * 本模块只产出可复核的数字，不做任何主观判断 / 预测。
 *
 * 覆盖：
 *  - 视频快照时序：按预设检查点（首采 / 6h / 24h / 48h / 7d / 30d）选取最接近的快照
 *  - 增长：相邻检查点之间的差值 + 增长率
 *  - 静态汇总：标题长度、时长、标签数、发布时间等可复核的结构化事实
 *  - 评论统计：总量 / 一级 / 二级 / 均赞 / 最高赞 / 回复率 / 时间跨度（服务 P0-E）
 */

import type { Video, VideoSnapshot } from '@models/video';
import type { Creator, CreatorSnapshot } from '@models/creator';
import type { Comment } from '@models/comment';

const HOUR = 3_600_000;

/** 视频时序检查点（毫秒）：首采 + 6h / 24h / 48h / 7d / 30d */
export const VIDEO_SNAPSHOT_CHECKPOINTS: ReadonlyArray<{ key: string; label: string; offsetMs: number }> = [
  { key: 'first', label: '首采', offsetMs: 0 },
  { key: 'h6', label: '6 小时', offsetMs: 6 * HOUR },
  { key: 'h24', label: '24 小时', offsetMs: 24 * HOUR },
  { key: 'h48', label: '48 小时', offsetMs: 48 * HOUR },
  { key: 'd7', label: '7 天', offsetMs: 7 * 24 * HOUR },
  { key: 'd30', label: '30 天', offsetMs: 30 * 24 * HOUR },
];

export interface SnapshotPoint {
  checkpoint: string;
  label: string;
  /** 与基准时间的目标偏移（ms） */
  targetOffsetMs: number;
  /** 实际选中的快照（可能为 null：还没到点 / 未采集） */
  snapshot: VideoSnapshot | null;
  /** 实际快照与目标时间相差多少 ms（>0 表示快照比目标晚） */
  driftMs: number | null;
}

/**
 * 判断某个快照是否「属于」某个检查点。
 * 容差：目标时间之后的 50% 间隔内都算命中（例如 6h 点允许 6h–9h 之间落点的快照）。
 * 这样定时采集稍有偏移也能正确归位，而不是硬性要求精确到毫秒。
 */
/**
 * 检查点归属：用「最近邻」划分（Voronoi 边界），而不是固定容差。
 *
 * 每个检查点 i 的归属区间 = 与前后检查点的中点之间：
 *   lower = (prev.offset + cp.offset) / 2，upper = (cp.offset + next.offset) / 2
 * 首点的下界延伸到 0（含略微提前的落点由 1h 容差兜底），末点的上界到 +∞。
 * 这样 23.97h 的快照只会归到 24h 点，而不会被 48h 点（上界很远）抢走。
 */
function belongsTo(deltaMs: number, idx: number): boolean {
  const cp = VIDEO_SNAPSHOT_CHECKPOINTS[idx]!;
  const prev = VIDEO_SNAPSHOT_CHECKPOINTS[idx - 1];
  const next = VIDEO_SNAPSHOT_CHECKPOINTS[idx + 1];
  const lower = prev ? (prev.offsetMs + cp.offsetMs) / 2 : cp.offsetMs - HOUR;
  const upper = next ? (cp.offsetMs + next.offsetMs) / 2 : Number.POSITIVE_INFINITY;
  return deltaMs >= lower && deltaMs <= upper;
}

/** 按检查点挑选视频时序上的代表快照 */
export function selectSnapshotPoints(
  snapshots: VideoSnapshot[],
  opts: { baseTs?: string } = {},
): SnapshotPoint[] {
  if (!snapshots.length) return [];
  const sorted = [...snapshots].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const base = opts.baseTs ? Date.parse(opts.baseTs) : Date.parse(sorted[0]!.timestamp);
  return VIDEO_SNAPSHOT_CHECKPOINTS.map((cp, idx) => {
    const target = base + cp.offsetMs;
    let best: VideoSnapshot | null = null;
    let bestDrift = Infinity;
    for (const s of sorted) {
      const delta = Date.parse(s.timestamp) - base;
      if (!belongsTo(delta, idx)) continue;
      const drift = Math.abs(Date.parse(s.timestamp) - target);
      if (drift < bestDrift) {
        bestDrift = drift;
        best = s;
      }
    }
    return {
      checkpoint: cp.key,
      label: cp.label,
      targetOffsetMs: cp.offsetMs,
      snapshot: best,
      driftMs: best ? Math.abs(Date.parse(best.timestamp) - target) : null,
    };
  });
}

export interface SnapshotGrowth {
  metric: keyof Pick<VideoSnapshot, 'views' | 'likes' | 'coins' | 'favorites' | 'shares' | 'comments' | 'danmaku'>;
  fromCheckpoint: string;
  toCheckpoint: string;
  fromValue: number | null;
  toValue: number | null;
  delta: number | null;
  /** 增长率（%）；基数为 0 或缺失时为 null，绝不编造 */
  growthPct: number | null;
  elapsedMs: number | null;
}

const METRICS = ['views', 'likes', 'coins', 'favorites', 'shares', 'comments', 'danmaku'] as const;

/** 相邻「有数据」检查点之间的各指标增长 */
export function computeSnapshotGrowth(points: SnapshotPoint[]): SnapshotGrowth[] {
  const withData = points.filter((p) => p.snapshot !== null);
  const out: SnapshotGrowth[] = [];
  for (let i = 1; i < withData.length; i++) {
    const prev = withData[i - 1]!;
    const cur = withData[i]!;
    const prevSnap = prev.snapshot!;
    const curSnap = cur.snapshot!;
    const elapsedMs = Date.parse(curSnap.timestamp) - Date.parse(prevSnap.timestamp);
    for (const m of METRICS) {
      const from = prevSnap[m];
      const to = curSnap[m];
      const delta = typeof from === 'number' && typeof to === 'number' ? to - from : null;
      const growthPct = typeof from === 'number' && typeof to === 'number' && from > 0 ? (delta! / from) * 100 : null;
      out.push({
        metric: m,
        fromCheckpoint: prev.checkpoint,
        toCheckpoint: cur.checkpoint,
        fromValue: from,
        toValue: to,
        delta,
        growthPct,
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      });
    }
  }
  return out;
}

/** 视频静态结构汇总（可复核事实，不含主观判断） */
export interface VideoStaticSummary {
  titleLength: number;
  descriptionLength: number;
  tagCount: number;
  durationSec: number | null;
  durationText: string | null;
  pubTime: string | null;
  hasCover: boolean;
  category: string;
  authorName: string | null;
  authorMid: number | null;
  views: number | null;
}

export function summarizeVideoStatic(video: Video): VideoStaticSummary {
  const d = video.duration;
  const durationText =
    typeof d === 'number'
      ? `${Math.floor(d / 60)
          .toString()
          .padStart(2, '0')}:${(d % 60).toString().padStart(2, '0')}`
      : null;
  return {
    titleLength: video.title.length,
    descriptionLength: video.description?.length ?? 0,
    tagCount: video.tags.length,
    durationSec: d,
    durationText,
    pubTime: video.pubTime,
    hasCover: typeof video.cover === 'string' && video.cover.length > 0,
    category: video.category,
    authorName: video.authorName ?? null,
    authorMid: video.authorMid ?? null,
    views: video.views ?? null,
  };
}

// ─────────────────────────────────────────────────────────── 评论统计（P0-E）

export interface CommentStats {
  total: number;
  topLevel: number;
  subReplies: number;
  /** 平均点赞（按一级评论算，避免二级把均值拉偏；无可算对象时为 null） */
  avgLikeTopLevel: number | null;
  maxLike: number | null;
  /** 回复率：有回复的一级评论占比（0–1；无一级评论时为 null） */
  replyRate: number | null;
  /** 时间跨度（最早 / 最晚评论的 ctime，ISO）；无评论时为 null */
  earliestCtime: string | null;
  latestCtime: string | null;
  spanMs: number | null;
  /** 去重后的参与用户数（按 mid） */
  uniqueUsers: number;
}

/**
 * 评论统计事实（P0-E）。纯函数，永不编造：拿不到就是 null。
 */
export function computeCommentStats(comments: Comment[]): CommentStats {
  if (!comments.length) {
    return {
      total: 0,
      topLevel: 0,
      subReplies: 0,
      avgLikeTopLevel: null,
      maxLike: null,
      replyRate: null,
      earliestCtime: null,
      latestCtime: null,
      spanMs: null,
      uniqueUsers: 0,
    };
  }
  const top = comments.filter((c) => c.replyLevel === 1);
  const sub = comments.filter((c) => c.replyLevel > 1);
  const likes = top.length ? top.map((c) => c.like) : comments.map((c) => c.like);
  const avgLikeTopLevel = likes.length ? likes.reduce((a, b) => a + b, 0) / likes.length : null;
  const maxLike = likes.length ? Math.max(...likes) : null;
  const withReplies = top.filter((c) => c.replyCount > 0).length;
  const replyRate = top.length ? withReplies / top.length : null;
  const ctimes = comments.map((c) => c.ctime).filter((t) => Number.isFinite(t) && t > 0);
  const earliest = ctimes.length ? Math.min(...ctimes) : null;
  const latest = ctimes.length ? Math.max(...ctimes) : null;
  return {
    total: comments.length,
    topLevel: top.length,
    subReplies: sub.length,
    avgLikeTopLevel,
    maxLike,
    replyRate,
    earliestCtime: earliest !== null ? new Date(earliest * 1000).toISOString() : null,
    latestCtime: latest !== null ? new Date(latest * 1000).toISOString() : null,
    spanMs: earliest !== null && latest !== null ? (latest - earliest) * 1000 : null,
    uniqueUsers: new Set(comments.map((c) => c.midStr)).size,
  };
}

/** 高频关键词（简单分词：按非中英文数字切分后计数）。仅作客观计数，不作主题推断。 */
export interface KeywordCount {
  keyword: string;
  count: number;
}

export function countKeywords(comments: Comment[], opts: { topN?: number; minLen?: number } = {}): KeywordCount[] {
  const topN = opts.topN ?? 20;
  const minLen = opts.minLen ?? 2;
  const freq = new Map<string, number>();
  for (const c of comments) {
    // 中文按 2–4 字滑窗粗略切分 + 英文/数字按词切分；只做计数，不做语义
    const tokens = c.content.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z0-9]{2,}/g) ?? [];
    for (const t of tokens) {
      const key = t.trim();
      if (key.length < minLen) continue;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .filter((k) => k.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/** 高赞评论 Top N（客观排序，无主观筛选） */
export function topComments(comments: Comment[], n = 10): Comment[] {
  return [...comments].sort((a, b) => b.like - a.like).slice(0, n);
}

// ─────────────────────────────────────────────────────────── 账号时序（Group C）

export interface CreatorDelta {
  fromCheckpoint: string;
  toCheckpoint: string;
  followerDelta: number | null;
  videoCountDelta: number | null;
  totalViewsDelta: number | null;
  elapsedMs: number | null;
}

/**
 * 账号结构变化：按快照时间顺序（首 → 末）计算粉丝 / 投稿 / 总播放变化。
 * 只描述事实，不解读「为什么涨」。
 */
export function computeCreatorDelta(snapshots: CreatorSnapshot[]): CreatorDelta | null {
  if (snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const sub = (a: number | null, b: number | null): number | null =>
    typeof a === 'number' && typeof b === 'number' ? b - a : null;
  return {
    fromCheckpoint: first.timestamp,
    toCheckpoint: last.timestamp,
    followerDelta: sub(first.followers, last.followers),
    videoCountDelta: sub(first.videoCount, last.videoCount),
    totalViewsDelta: sub(first.totalViews, last.totalViews),
    elapsedMs: Date.parse(last.timestamp) - Date.parse(first.timestamp),
  };
}

/** 账号静态汇总（可复核事实） */
export interface CreatorStaticSummary {
  level: number | null;
  followers: number | null;
  following: number | null;
  videoCount: number | null;
  hasSign: boolean;
  signLength: number;
  nameLength: number;
}

export function summarizeCreatorStatic(creator: Creator): CreatorStaticSummary {
  return {
    level: creator.level ?? null,
    followers: creator.followers ?? null,
    following: creator.following ?? null,
    videoCount: creator.videoCount ?? null,
    hasSign: typeof creator.sign === 'string' && creator.sign.length > 0,
    signLength: creator.sign?.length ?? 0,
    nameLength: creator.name.length,
  };
}
