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
  });

  it('returns zeros on malformed', () => {
    const t = normalizeCreatorTotals(null);
    expect(t.totalViews).toBe(0);
    expect(t.totalLikes).toBe(0);
  });
});