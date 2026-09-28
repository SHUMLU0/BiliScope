import { describe, expect, it } from 'vitest';
import {
  creatorContentStructure,
  creatorContentChange,
  detectBreakoutVideos,
  radarKeywordSummary,
} from '@services/creator-research';
import type { Video } from '@models/video';

const iso = (s: string) => new Date(s).toISOString();

const v = (over: Partial<Video> & { id: string }): Video => ({
  bvid: 'BV1xx411c7m1',
  aid: 1,
  creatorId: 'cr1',
  title: 't',
  description: '',
  pubTime: iso('2026-01-01T10:00:00Z'),
  duration: 300,
  category: '科技',
  tags: [],
  url: 'https://www.bilibili.com/video/BV1xx411c7m1',
  createdAt: iso('2026-01-01T00:00:00Z'),
  updatedAt: iso('2026-01-01T00:00:00Z'),
  source: 'bili-api',
  ...over,
});

describe('creatorContentStructure', () => {
  it('builds category/duration distributions and publish frequency', () => {
    const videos = [
      v({ id: 'a', category: '科技', duration: 30, tags: ['ai', '工具'] }),
      v({ id: 'b', category: '科技', duration: 590, tags: ['ai'] }),
      v({ id: 'c', category: '生活', duration: 2000, tags: ['vlog'] }),
    ];
    const s = creatorContentStructure(videos);
    expect(s.videoCount).toBe(3);
    const cat = Object.fromEntries(s.categoryDistribution.map((d) => [d.key, d.count]));
    expect(cat['科技']).toBe(2);
    expect(cat['生活']).toBe(1);
    const dur = Object.fromEntries(s.durationDistribution.map((d) => [d.key, d.count]));
    expect(dur['< 1 分钟']).toBe(1);
    expect(dur['5–10 分钟']).toBe(1); // 590s ∈ [300, 600)
    expect(dur['≥ 30 分钟']).toBe(1);
    expect(s.topTags[0]).toEqual({ tag: 'ai', count: 2 });
    expect(s.publishByHour.length).toBe(24);
    expect(s.publishByWeekday.length).toBe(7);
    expect(s.note).toContain('不含任何走势预测');
  });

  it('handles missing category/duration gracefully', () => {
    const s = creatorContentStructure([v({ id: 'a', category: '', duration: null })]);
    expect(s.categoryDistribution[0]!.key).toBe('未知');
    expect(s.durationDistribution).toHaveLength(0); // 无时长 → 无分布
  });
});

describe('creatorContentChange', () => {
  it('compares early vs recent windows', () => {
    const videos = [
      v({ id: '1', pubTime: iso('2026-01-01T00:00:00Z'), category: '游戏', duration: 100 }),
      v({ id: '2', pubTime: iso('2026-01-11T00:00:00Z'), category: '游戏', duration: 100 }),
      v({ id: '3', pubTime: iso('2026-02-01T00:00:00Z'), category: '科技', duration: 500 }),
      v({ id: '4', pubTime: iso('2026-02-11T00:00:00Z'), category: '科技', duration: 500 }),
    ];
    const c = creatorContentChange(videos);
    expect(c.earlyCount).toBe(2);
    expect(c.recentCount).toBe(2);
    expect(c.earlyTopCategory).toBe('游戏');
    expect(c.recentTopCategory).toBe('科技');
    expect(c.categoryShifted).toBe(true);
    // 近期平均时长 500，早期 100 → +400
    expect(c.durationDelta).toBe(400);
    expect(c.earlyRatePer30d).toBeGreaterThan(0);
  });

  it('fewer than 2 dated videos → empty note', () => {
    const c = creatorContentChange([v({ id: '1' })]);
    expect(c.earlyCount).toBe(0);
    expect(c.note).toContain('不足');
  });
});

describe('detectBreakoutVideos', () => {
  it('flags videos >= threshold × median', () => {
    const videos = [10, 12, 11, 13, 100].map((views, i) =>
      v({ id: `v${i}`, bvid: `BV1xx411c7m${i}`, views })
    );
    const b = detectBreakoutVideos(videos, { threshold: 2 });
    // median = 12（排序后 10,11,12,13,100 → 12）；100/12 ≈ 8.3 倍
    expect(b).toHaveLength(1);
    expect(b[0]!.views).toBe(100);
    expect(b[0]!.multipleOfMedian).toBeGreaterThan(2);
  });

  it('needs minSamples (default 5)', () => {
    const videos = [1, 2, 100].map((views, i) => v({ id: `v${i}`, views }));
    expect(detectBreakoutVideos(videos)).toHaveLength(0);
  });

  it('no views data → empty', () => {
    expect(detectBreakoutVideos([v({ id: 'a', views: undefined })])).toHaveLength(0);
  });
});

describe('radarKeywordSummary', () => {
  it('computes median/avg views + top authors', () => {
    const videos = [
      v({ id: 'a', views: 100, authorName: 'A' }),
      v({ id: 'b', views: 300, authorName: 'A' }),
      v({ id: 'c', views: 500, authorName: 'B' }),
      v({ id: 'd', views: 700, authorName: 'C' }),
    ];
    const s = radarKeywordSummary('ai 工具', videos);
    expect(s.resultCount).toBe(4);
    expect(s.medianViews).toBe(400); // (300+500)/2
    expect(s.avgViews).toBe(400);
    expect(s.topAuthors[0]).toEqual({ author: 'A', count: 2 });
    expect(s.note).toContain('不代表竞争度');
  });

  it('empty → nulls, not zeros', () => {
    const s = radarKeywordSummary('x', []);
    expect(s.resultCount).toBe(0);
    expect(s.medianViews).toBeNull();
    expect(s.avgViews).toBeNull();
  });
});
