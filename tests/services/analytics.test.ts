import { describe, expect, it } from 'vitest';
import {
  selectSnapshotPoints,
  computeSnapshotGrowth,
  summarizeVideoStatic,
  computeCommentStats,
  countKeywords,
  topComments,
  computeCreatorDelta,
} from '@services/analytics';
import type { Video, VideoSnapshot } from '@models/video';
import type { CreatorSnapshot } from '@models/creator';
import type { Comment } from '@models/comment';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const HOUR = 3_600_000;

function snap(offsetMs: number, over: Partial<VideoSnapshot> = {}): VideoSnapshot {
  return {
    id: `vs${offsetMs}`,
    videoId: 'v1',
    timestamp: iso(offsetMs),
    views: null,
    likes: null,
    coins: null,
    favorites: null,
    shares: null,
    comments: null,
    danmaku: null,
    source: 'bili-api',
    ...over,
  };
}

const video: Video = {
  id: 'v1',
  bvid: 'BV1xx411c7m1',
  aid: 1,
  creatorId: 'cr1',
  title: '标题标题',
  description: '描述',
  pubTime: iso(0),
  duration: 125,
  category: '科技',
  tags: ['a', 'b'],
  url: 'https://www.bilibili.com/video/BV1xx411c7m1',
  authorName: 'up',
  authorMid: 7,
  views: 100,
  createdAt: iso(0),
  updatedAt: iso(0),
  source: 'bili-api',
};

describe('selectSnapshotPoints', () => {
  it('picks the closest snapshot per checkpoint', () => {
    const snaps = [
      snap(0, { views: 100 }),
      snap(6 * HOUR + 60_000, { views: 150 }), // 6h 点（略晚）
      snap(24 * HOUR - 120_000, { views: 300 }), // 24h 点（略早，仍在窗口内）
      snap(9 * 24 * HOUR, { views: 999 }), // 9 天落点：落在 d7 窗口（7d~18.5d）内，但离 d30 太远
    ];
    const pts = selectSnapshotPoints(snaps);
    const byKey = Object.fromEntries(pts.map((p) => [p.checkpoint, p]));
    expect(byKey.first!.snapshot?.views).toBe(100);
    expect(byKey.h6!.snapshot?.views).toBe(150);
    expect(byKey.h24!.snapshot?.views).toBe(300);
    expect(byKey.h48!.snapshot).toBeNull();
    // 9 天落点：d7~d30 的归属边界中点 = (7d+30d)/2 = 18.5d，9d < 18.5d → 归 d7
    expect(byKey.d7!.snapshot?.views).toBe(999);
    expect(byKey.d30!.snapshot).toBeNull();
  });

  it('returns empty for no snapshots', () => {
    expect(selectSnapshotPoints([])).toEqual([]);
  });
});

describe('computeSnapshotGrowth', () => {
  it('computes delta + growth between adjacent data points', () => {
    const snaps = [
      snap(0, { views: 100, likes: 10 }),
      snap(6 * HOUR, { views: 200, likes: 30 }),
      snap(24 * HOUR, { views: 500, likes: 60 }),
    ];
    const growth = computeSnapshotGrowth(selectSnapshotPoints(snaps));
    const firstToSecond = growth.find((g) => g.metric === 'views' && g.fromCheckpoint === 'first' && g.toCheckpoint === 'h6')!;
    expect(firstToSecond.delta).toBe(100);
    expect(firstToSecond.growthPct).toBeCloseTo(100);
    const likesG = growth.find((g) => g.metric === 'likes' && g.fromCheckpoint === 'h6' && g.toCheckpoint === 'h24')!;
    expect(likesG.delta).toBe(30);
    expect(likesG.growthPct).toBeCloseTo(100);
  });

  it('never fabricates growth when base value is null/0', () => {
    const snaps = [snap(0, { views: null }), snap(6 * HOUR, { views: 50 })];
    const growth = computeSnapshotGrowth(selectSnapshotPoints(snaps));
    const g = growth.find((x) => x.metric === 'views')!;
    expect(g.delta).toBeNull();
    expect(g.growthPct).toBeNull();
  });
});

describe('summarizeVideoStatic', () => {
  it('formats duration and counts fields', () => {
    const s = summarizeVideoStatic(video);
    expect(s.titleLength).toBe(4);
    expect(s.tagCount).toBe(2);
    expect(s.durationSec).toBe(125);
    expect(s.durationText).toBe('02:05');
    expect(s.hasCover).toBe(false);
    expect(s.authorMid).toBe(7);
  });

  it('duration null stays null', () => {
    const s = summarizeVideoStatic({ ...video, duration: null });
    expect(s.durationText).toBeNull();
  });
});

describe('computeCommentStats', () => {
  const cm = (level: number, like: number, replyCount: number, ctime: number, mid: string): Comment => ({
    id: `c${mid}${ctime}`,
    videoId: 'v1',
    rpid: ctime,
    rpidStr: String(ctime),
    mid: Number(mid),
    midStr: mid,
    rootRpid: 0,
    parentRpid: 0,
    dialog: 0,
    replyLevel: level as 1 | 2 | 3,
    like,
    replyCount,
    ctime,
    uname: `u${mid}`,
    content: '内容',
    level: 0,
    createdAt: iso(0),
    updatedAt: iso(0),
    source: 'wbi-main',
  });

  it('computes top/sub/avg/max/replyRate/span/uniqueUsers', () => {
    const list = [
      cm(1, 10, 3, 1000, '1'),
      cm(1, 20, 0, 2000, '2'),
      cm(2, 5, 0, 3000, '1'), // 二级
      cm(2, 1, 0, 4000, '3'), // 二级
    ];
    const s = computeCommentStats(list);
    expect(s.total).toBe(4);
    expect(s.topLevel).toBe(2);
    expect(s.subReplies).toBe(2);
    expect(s.avgLikeTopLevel).toBe(15); // (10+20)/2
    expect(s.maxLike).toBe(20);
    expect(s.replyRate).toBe(0.5); // 1/2 一级有回复
    expect(s.uniqueUsers).toBe(3); // mid 1,2,3
    expect(s.spanMs).toBe((4000 - 1000) * 1000);
    expect(s.earliestCtime).toBe(new Date(1000 * 1000).toISOString());
  });

  it('empty → all null, never 0-as-fact', () => {
    const s = computeCommentStats([]);
    expect(s.total).toBe(0);
    expect(s.avgLikeTopLevel).toBeNull();
    expect(s.maxLike).toBeNull();
    expect(s.replyRate).toBeNull();
    expect(s.spanMs).toBeNull();
  });
});

describe('countKeywords / topComments', () => {
  const mk = (content: string, like: number): Comment => ({
    id: `c${content}`,
    videoId: 'v1',
    rpid: 1,
    rpidStr: '1',
    mid: 1,
    midStr: '1',
    rootRpid: 0,
    parentRpid: 0,
    dialog: 0,
    replyLevel: 1,
    like,
    replyCount: 0,
    ctime: 1,
    uname: 'u',
    content,
    level: 0,
    createdAt: iso(0),
    updatedAt: iso(0),
    source: 'wbi-main',
  });

  it('counts repeated keywords only (count>1)', () => {
    const list = [mk('好用 好用 推荐', 1), mk('好用 一般', 2)];
    const kw = countKeywords(list);
    const map = Object.fromEntries(kw.map((k) => [k.keyword, k.count]));
    expect(map['好用']).toBe(3);
    expect(map['推荐']).toBeUndefined(); // 只出现一次，被过滤
  });

  it('topComments sorts by like desc', () => {
    const list = [mk('a', 1), mk('b', 9), mk('c', 5)];
    expect(topComments(list, 2).map((c) => c.content)).toEqual(['b', 'c']);
  });
});

describe('computeCreatorDelta', () => {
  const cs = (offsetMs: number, followers: number | null, videos: number | null): CreatorSnapshot => ({
    id: `cs${offsetMs}`,
    creatorId: 'cr1',
    timestamp: iso(offsetMs),
    followers,
    following: 1,
    videoCount: videos,
    totalViews: null,
    totalLikes: null,
    totalComments: null,
    totalFavorites: null,
    source: 'bili-api',
  });

  it('computes follower/video deltas across first→last', () => {
    const d = computeCreatorDelta([cs(0, 100, 10), cs(24 * HOUR, 150, 12)])!;
    expect(d.followerDelta).toBe(50);
    expect(d.videoCountDelta).toBe(2);
    expect(d.totalViewsDelta).toBeNull(); // 缺数据就是 null
    expect(d.elapsedMs).toBe(24 * HOUR);
  });

  it('returns null with fewer than 2 snapshots', () => {
    expect(computeCreatorDelta([cs(0, 1, 1)])).toBeNull();
    expect(computeCreatorDelta([])).toBeNull();
  });
});
