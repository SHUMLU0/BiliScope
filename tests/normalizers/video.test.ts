import { describe, expect, it } from 'vitest';
import { normalizeVideoList, normalizeVideoStat } from '@normalizers/video';

describe('normalizeVideoList', () => {
  it('extracts vlist from data.vlist', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          {
            bvid: 'BV1xxxxxxxxx',
            aid: 1,
            title: 't',
            desc: 'd',
            pic: 'p',
            pubdate: 1700000000,
            duration: 100,
            tname: '生活',
            tag: 'a,b,c',
          },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c1' });
    expect(list).toHaveLength(1);
    const v = list[0]!;
    expect(v.bvid).toBe('BV1xxxxxxxxx');
    expect(v.tags).toEqual(['a', 'b', 'c']);
    expect(v.category).toBe('生活');
  });

  it('extracts vlist from data.list.vlist', () => {
    const raw = {
      code: 0,
      data: {
        list: {
          vlist: [{ bvid: 'BV1xxxxxxxxx', aid: 2, title: 't2' }],
        },
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c2' });
    expect(list).toHaveLength(1);
  });

  it('empty on non-zero code', () => {
    const raw = { code: -101, message: '鉴权失败' };
    expect(normalizeVideoList(raw, { creatorId: 'c' })).toEqual([]);
  });

  it('skips invalid items', () => {
    const raw = {
      data: {
        vlist: [
          { bvid: 'INVALID' },
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 'ok' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list).toHaveLength(1);
  });
});

describe('normalizeVideoStat', () => {
  it('happy path', () => {
    const stat = normalizeVideoStat({
      code: 0,
      data: {
        bvid: 'BV1xxxxxxxxxx',
        aid: 1,
        view: 1000,
        like: 50,
        coin: 10,
        favorite: 5,
        share: 1,
        reply: 2,
        danmaku: 30,
      },
    });
    expect(stat?.views).toBe(1000);
    expect(stat?.likes).toBe(50);
  });

  it('returns null on bad input', () => {
    expect(normalizeVideoStat(null)).toBeNull();
    expect(normalizeVideoStat({ code: -1 })).toBeNull();
  });
});