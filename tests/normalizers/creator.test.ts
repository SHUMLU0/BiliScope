import { describe, expect, it } from 'vitest';
import { normalizeCreator, normalizeCreatorTotals } from '@normalizers/creator';

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

  it('fills defaults for missing optional fields', () => {
    const raw = {
      data: {
        mid: 1,
        name: 'm',
        level_info: { current_level: 0 },
      },
    };
    const c = normalizeCreator(raw);
    expect(c.sign).toBe('');
    expect(c.followers).toBe(0);
    expect(c.following).toBe(0);
    expect(c.videoCount).toBe(0);
    expect(c.level).toBe(0);
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
});