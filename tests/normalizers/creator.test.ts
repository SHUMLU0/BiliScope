import { describe, expect, it } from 'vitest';
import {
  normalizeCreator,
  normalizeCreatorTotals,
  normalizeNavnum,
  normalizeRelationStat,
} from '@normalizers/creator';

describe('normalizeCreator', () => {
  it('happy path', () => {
    const raw = {
      code: 0,
      data: {
        mid: 123,
        name: 'foo',
        face: 'https://example.com/f.jpg',
        sign: 'hi',
        level_info: { current_level: 5 },
        fans: 1000,
        following: 10,
        archive: { count: 7 },
      },
    };
    const c = normalizeCreator(raw);
    expect(c.uid).toBe(123);
    expect(c.name).toBe('foo');
    expect(c.followers).toBe(1000);
    expect(c.level).toBe(5);
    expect(c.spaceUrl).toBe('https://space.bilibili.com/123/');
    expect(c.source).toBe('bili-api');
  });

  it('throws on invalid', () => {
    expect(() => normalizeCreator({ code: -1 })).toThrow();
    expect(() => normalizeCreator(null)).toThrow();
    expect(() => normalizeCreator('not object')).toThrow();
  });

  // V0.1.3（P0-1 / P0-2）：字段缺失必须是 null，绝不能为了过 Zod 填 0
  it('missing counters become null (not 0)', () => {
    const raw = {
      data: {
        mid: 1,
        name: 'm',
        level_info: { current_level: 0 },
      },
    };
    const c = normalizeCreator(raw);
    expect(c.sign).toBe('');
    expect(c.followers).toBeNull();
    expect(c.following).toBeNull();
    expect(c.videoCount).toBeNull();
    expect(c.level).toBe(0);
  });

  // V0.1.3（P0-1）：真实 wbi/acc/info 用 attention 表示关注、archive_count 表示投稿；
  // 旧实现只读 following / archive.count，于是粉丝/关注/投稿全是 0。
  it('maps real wbi/acc/info fields: fans / attention / archive_count', () => {
    const c = normalizeCreator({
      code: 0,
      data: {
        mid: 946974,
        name: '影视飓风',
        fans: 18442623,
        attention: 686,
        archive_count: 934,
        level_info: { current_level: 6 },
      },
    });
    expect(c.followers).toBe(18442623);
    expect(c.following).toBe(686);
    expect(c.videoCount).toBe(934);
    expect(c.level).toBe(6);
  });

  it('accepts legacy fans / following / archive.count too', () => {
    const c = normalizeCreator({
      code: 0,
      data: { mid: 2, name: 'legacy', fans: 11, following: 22, archive: { count: 33 } },
    });
    expect(c.followers).toBe(11);
    expect(c.following).toBe(22);
    expect(c.videoCount).toBe(33);
  });

  // 真实来源：tests/fixtures/real/relation-stat.json（匿名实机抓取 code=0）
  describe('normalizeRelationStat / normalizeNavnum', () => {
    it('relation/stat: follower + following', () => {
      const r = normalizeRelationStat({
        code: 0,
        data: { mid: 946974, following: 686, follower: 18442623 },
      });
      expect(r.followers).toBe(18442623);
      expect(r.following).toBe(686);
    });

    it('relation/stat: blocked → null', () => {
      const r = normalizeRelationStat({ code: -352, data: null });
      expect(r.followers).toBeNull();
      expect(r.following).toBeNull();
    });

    it('navnum: data.video is the real video count', () => {
      const r = normalizeNavnum({ code: 0, data: { video: 934, article: 126 } });
      expect(r.videoCount).toBe(934);
    });

    it('navnum: blocked → null', () => {
      expect(normalizeNavnum({ code: -352 }).videoCount).toBeNull();
    });
  });
});

describe('normalizeCreatorTotals', () => {
  it('parses upstat', () => {
    const t = normalizeCreatorTotals({ archive: { view: 100 }, article: { view: 50 }, likes: 7 });
    expect(t.totalViews).toBe(150);
    expect(t.totalLikes).toBe(7);
    expect(t.available).toBe(true);
  });

  it('parses upstat wrapped in code/data envelope', () => {
    const t = normalizeCreatorTotals({
      code: 0,
      data: { archive: { view: 10 }, article: { view: 0 }, likes: 1 },
    });
    expect(t.totalViews).toBe(10);
    expect(t.available).toBe(true);
  });

  // V0.1.2（P1-6）：拿不到数据时必须是 null，不能用 0 伪装
  it('returns null (not 0) on malformed / missing', () => {
    const t = normalizeCreatorTotals(null);
    expect(t.totalViews).toBeNull();
    expect(t.totalLikes).toBeNull();
    expect(t.available).toBe(false);
  });

  it('returns null when B 站 returns risk-control code', () => {
    const t = normalizeCreatorTotals({ code: -352, message: '风控', data: null });
    expect(t.totalViews).toBeNull();
    expect(t.available).toBe(false);
  });

  // 真实匿名响应（tests/fixtures/real/upstat.json）就是 code=0 但 data 为空对象：
  // 这必须判为「不可用」，不能算成 0 播放。
  it('empty data object means unavailable, not zero', () => {
    const t = normalizeCreatorTotals({ code: 0, message: 'OK', data: {} });
    expect(t.available).toBe(false);
    expect(t.totalViews).toBeNull();
    expect(t.totalLikes).toBeNull();
  });
});