/**
 * 账号研究（V0.2 · P1 · Group C）。
 *
 * 纯函数：输入创作者 + 其视频 + 视频快照 + 账号快照 → 输出**描述性**结构事实。
 * 明确禁止：爆款概率 / 走向预测 / 主观评价。只回答「发生了什么」。
 *
 * 三类结果：
 *  - 内容结构：分区分布、时长分布、标签频次、发布节奏（按小时/星期）
 *  - 内容变化：早/晚两窗对比（分区漂移、时长变化、发布频率变化）
 *  - 突破：按播放中位数识别「显著高于自身常态」的视频（只描述事实与倍数）
 */

import type { Creator, CreatorSnapshot } from '@models/creator';
import type { Video, VideoSnapshot } from '@models/video';

export interface DistributionBucket {
  key: string;
  count: number;
  /** 占比（0–1） */
  ratio: number;
}

export interface CreatorContentStructure {
  videoCount: number;
  /** 分区分布（按 category） */
  categoryDistribution: DistributionBucket[];
  /** 时长分布（分桶：<1m / 1–5m / 5–10m / 10–30m / ≥30m） */
  durationDistribution: DistributionBucket[];
  /** 标签频次 Top N */
  topTags: { tag: string; count: number }[];
  /** 发布节奏：按小时（0–23）与按星期（0–6，0=周日） */
  publishByHour: number[];
  publishByWeekday: number[];
  /** 统计口径说明（供 UI 展示，强调这些是事实而非预测） */
  note: string;
}

const DURATION_BUCKETS: { key: string; test: (sec: number) => boolean }[] = [
  { key: '< 1 分钟', test: (s) => s < 60 },
  { key: '1–5 分钟', test: (s) => s >= 60 && s < 300 },
  { key: '5–10 分钟', test: (s) => s >= 300 && s < 600 },
  { key: '10–30 分钟', test: (s) => s >= 600 && s < 1800 },
  { key: '≥ 30 分钟', test: (s) => s >= 1800 },
];

function toDistribution(map: Map<string, number>, total: number): DistributionBucket[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count, ratio: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
}

/** 账号内容静态结构（描述性事实） */
export function creatorContentStructure(videos: Video[]): CreatorContentStructure {
  const n = videos.length;
  const cats = new Map<string, number>();
  const durs = new Map<string, number>();
  const tags = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);

  for (const v of videos) {
    const cat = v.category?.trim() || '未知';
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
    if (typeof v.duration === 'number') {
      const bucket = DURATION_BUCKETS.find((b) => b.test(v.duration!));
      if (bucket) durs.set(bucket.key, (durs.get(bucket.key) ?? 0) + 1);
    }
    for (const t of v.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (v.pubTime) {
      const d = new Date(v.pubTime);
      if (!Number.isNaN(d.getTime())) {
        byHour[d.getHours()]!++;
        byWeekday[d.getDay()]!++;
      }
    }
  }

  return {
    videoCount: n,
    categoryDistribution: toDistribution(cats, n),
    durationDistribution: toDistribution(durs, n),
    topTags: [...tags.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    publishByHour: byHour,
    publishByWeekday: byWeekday,
    note: '以上为账号已采集视频的客观分布（分区/时长/标签/发布时段），不含任何走势预测。',
  };
}

export interface CreatorContentChange {
  /** 早期窗口视频数 / 近期窗口视频数 */
  earlyCount: number;
  recentCount: number;
  /** 分区漂移：早期主分区 → 近期主分区 */
  earlyTopCategory: string | null;
  recentTopCategory: string | null;
  categoryShifted: boolean;
  /** 平均时长变化（秒；任一侧无数据为 null） */
  earlyAvgDuration: number | null;
  recentAvgDuration: number | null;
  durationDelta: number | null;
  /** 发布频率：每 30 天发布数（按窗口跨度推算；跨度为 0 时为 null） */
  earlyRatePer30d: number | null;
  recentRatePer30d: number | null;
  note: string;
}

/** 账号内容变化：把视频按发布时间切成「前半段 / 后半段」两窗对比（描述性） */
export function creatorContentChange(videos: Video[]): CreatorContentChange {
  const dated = videos
    .filter((v) => v.pubTime && !Number.isNaN(Date.parse(v.pubTime)))
    .sort((a, b) => (a.pubTime! < b.pubTime! ? 1 : -1)); // 新 → 旧
  const empty: CreatorContentChange = {
    earlyCount: 0,
    recentCount: 0,
    earlyTopCategory: null,
    recentTopCategory: null,
    categoryShifted: false,
    earlyAvgDuration: null,
    recentAvgDuration: null,
    durationDelta: null,
    earlyRatePer30d: null,
    recentRatePer30d: null,
    note: '可比较的视频不足（需要至少 2 个带发布时间的视频）。',
  };
  if (dated.length < 2) return empty;
  const half = Math.floor(dated.length / 2);
  const recent = dated.slice(0, half);
  const early = dated.slice(half);

  const topCat = (arr: Video[]): string | null => {
    const m = new Map<string, number>();
    for (const v of arr) {
      const c = v.category?.trim() || '未知';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] ?? null;
  };
  const avgDur = (arr: Video[]): number | null => {
    const d = arr.map((v) => v.duration).filter((x): x is number => typeof x === 'number');
    return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  };
  const rate = (arr: Video[]): number | null => {
    if (arr.length < 2) return null;
    const newest = Date.parse(arr[0]!.pubTime!);
    const oldest = Date.parse(arr[arr.length - 1]!.pubTime!);
    const spanDays = (newest - oldest) / 86_400_000;
    if (spanDays <= 0) return null;
    return (arr.length / spanDays) * 30;
  };

  const earlyTop = topCat(early);
  const recentTop = topCat(recent);
  const earlyAvg = avgDur(early);
  const recentAvg = avgDur(recent);
  return {
    earlyCount: early.length,
    recentCount: recent.length,
    earlyTopCategory: earlyTop,
    recentTopCategory: recentTop,
    categoryShifted: earlyTop !== null && recentTop !== null && earlyTop !== recentTop,
    earlyAvgDuration: earlyAvg,
    recentAvgDuration: recentAvg,
    durationDelta: earlyAvg !== null && recentAvg !== null ? recentAvg - earlyAvg : null,
    earlyRatePer30d: rate(early),
    recentRatePer30d: rate(recent),
    note: '把已采集视频按发布时间分为前/后两半对比，仅描述差异，不代表趋势判断。',
  };
}

export interface BreakoutVideo {
  videoId: string;
  bvid: string;
  title: string;
  views: number;
  /** 相对该账号播放中位数的倍数（如 3.2 表示 3.2 倍） */
  multipleOfMedian: number;
  pubTime: string | null;
}

/**
 * 突破视频：播放量显著高于该账号自身中位数的视频（描述性，用倍数表达）。
 * 阈值默认 2 倍中位数；不足 5 个有播放数据的视频时不判定（样本太少）。
 */
export function detectBreakoutVideos(
  videos: Video[],
  opts: { threshold?: number; minSamples?: number } = {},
): BreakoutVideo[] {
  const threshold = opts.threshold ?? 2;
  const minSamples = opts.minSamples ?? 5;
  const withViews = videos.filter((v) => typeof v.views === 'number' && v.views! > 0);
  if (withViews.length < minSamples) return [];
  const sorted = withViews.map((v) => v.views!).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  if (median <= 0) return [];
  return withViews
    .map((v) => ({
      videoId: v.id,
      bvid: v.bvid,
      title: v.title,
      views: v.views!,
      multipleOfMedian: v.views! / median,
      pubTime: v.pubTime,
    }))
    .filter((b) => b.multipleOfMedian >= threshold)
    .sort((a, b) => b.multipleOfMedian - a.multipleOfMedian);
}

// ─────────────────────────────────────────────────────────── 全站 Radar（描述性）

export interface RadarKeywordResult {
  keyword: string;
  /** 搜索结果条数 */
  resultCount: number;
  /** 播放中位数 / 均值（缺数据为 null） */
  medianViews: number | null;
  avgViews: number | null;
  /** 头部 UP 分布（作者名 → 出现次数） */
  topAuthors: { author: string; count: number }[];
  /** 时长中位数（秒） */
  medianDurationSec: number | null;
  note: string;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 把一次关键词搜索的结果汇总为描述性生态画像（不含「竞争度」这类主观判断） */
export function radarKeywordSummary(keyword: string, videos: Video[]): RadarKeywordResult {
  const views = videos.map((v) => v.views).filter((x): x is number => typeof x === 'number');
  const durations = videos.map((v) => v.duration).filter((x): x is number => typeof x === 'number');
  const authors = new Map<string, number>();
  for (const v of videos) {
    const a = v.authorName ?? (v.authorMid ? `uid:${v.authorMid}` : null);
    if (a) authors.set(a, (authors.get(a) ?? 0) + 1);
  }
  return {
    keyword,
    resultCount: videos.length,
    medianViews: median(views),
    avgViews: views.length ? views.reduce((a, b) => a + b, 0) / views.length : null,
    topAuthors: [...authors.entries()]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    medianDurationSec: median(durations),
    note: '以上为该关键词当次搜索结果的客观统计（条数/播放中位数/头部作者），不代表竞争度或推荐结论。',
  };
}

/** 账号时序汇总（复用 analytics 的 delta，这里只做入口聚合，避免循环依赖） */
export interface CreatorTimelineSummary {
  snapshotCount: number;
  firstTs: string | null;
  lastTs: string | null;
  note: string;
}

export function creatorTimelineSummary(snapshots: CreatorSnapshot[]): CreatorTimelineSummary {
  if (!snapshots.length) {
    return { snapshotCount: 0, firstTs: null, lastTs: null, note: '暂无账号时序快照。' };
  }
  const sorted = [...snapshots].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return {
    snapshotCount: sorted.length,
    firstTs: sorted[0]!.timestamp,
    lastTs: sorted[sorted.length - 1]!.timestamp,
    note: '账号时序快照覆盖范围；增长数值见 computeCreatorDelta。',
  };
}

/** 供 UI 显示的账号卡片事实（不含评价） */
export function creatorFacts(creator: Creator, videos: Video[]): {
  name: string;
  level: number | null;
  followers: number | null;
  videoCount: number | null;
  collectedVideos: number;
  hasBreakout: boolean;
} {
  return {
    name: creator.name,
    level: creator.level,
    followers: creator.followers,
    videoCount: creator.videoCount,
    collectedVideos: videos.length,
    hasBreakout: detectBreakoutVideos(videos).length > 0,
  };
}

export type { Video, VideoSnapshot };
