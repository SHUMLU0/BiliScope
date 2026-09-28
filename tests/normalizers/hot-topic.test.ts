import { describe, expect, it } from 'vitest';
import { hotTopicBusinessId, normalizeHotList, normalizeHotSearch } from '@normalizers/hot-topic';

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

  // V0.1.2（P1-9）：id 必须是业务键，重复刷新同一份榜单不能产生新行
  it('同一榜单重复归一化得到相同 id（去重 / 快照语义）', () => {
    const raw = { code: 0, data: { list: [{ title: 't1' }, { title: 't2' }] } };
    const a = normalizeHotList(raw);
    const b = normalizeHotList(raw);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(new Set(a.map((x) => x.id)).size).toBe(2);
  });

  it('不同 source 的同名条目互不覆盖', () => {
    const id1 = hotTopicBusinessId('bili-hot', 'AI');
    const id2 = hotTopicBusinessId('bili-search', 'AI');
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('ht_')).toBe(true);
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