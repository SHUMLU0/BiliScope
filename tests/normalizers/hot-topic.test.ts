import { describe, expect, it } from 'vitest';
import { normalizeHotList, normalizeHotSearch } from '@normalizers/hot-topic';

describe('normalizeHotList', () => {
  it('happy path', () => {
    const raw = {
      code: 0,
      data: {
        list: [
          { aid: 1, bvid: 'BV1xxxxxxxxxx', title: 't1', tname: '知识' },
          { title: 't2' },
        ],
      },
    };
    const list = normalizeHotList(raw);
    expect(list).toHaveLength(2);
    expect(list[0]!.rank).toBe(1);
    expect(list[1]!.rank).toBe(2);
    expect(list[0]!.source).toBe('bili-hot');
  });

  it('empty on non-zero', () => {
    expect(normalizeHotList({ code: -1 })).toEqual([]);
  });
});

describe('normalizeHotSearch', () => {
  it('happy path', () => {
    const raw = {
      code: 0,
      data: {
        trending: {
          list: [{ keyword: 'AI', show_name: 'AI 工具' }],
        },
      },
    };
    const list = normalizeHotSearch(raw);
    expect(list).toHaveLength(1);
    expect(list[0]!.source).toBe('bili-search');
    expect(list[0]!.relatedTags).toContain('AI');
  });
});