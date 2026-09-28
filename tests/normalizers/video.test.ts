import { describe, expect, it } from 'vitest';
import { normalizeVideoList, normalizeVideoStat, parseDurationToSeconds } from '@normalizers/video';

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
    expect(v.duration).toBe(100);
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

  // V0.1.1 修复（独立验收反馈）：
  // 真实 B 站搜索结果里 duration 是 "MM:SS" / "HH:MM:SS" 字符串，
  // archive API 是 number。两种都要能正确归一化为秒。
  it('accepts duration as numeric string "330"', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 't', duration: '330' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list[0]!.duration).toBe(330);
  });

  it('accepts duration as "MM:SS" string "5:30"', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 't', duration: '5:30' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list[0]!.duration).toBe(330);
  });

  it('accepts duration as "HH:MM:SS" string "1:02:03"', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 't', duration: '1:02:03' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list[0]!.duration).toBe(3723);
  });

  // V0.1.3（P0-3）：无法解析的 duration 必须是 null（未知），
  // 不能写成 0 —— 页面上的 "0s" 会被误读成真实时长。
  it('garbage duration becomes null (unknown), not 0', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 't', duration: 'abc' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list[0]!.duration).toBeNull();
  });

  // V0.1.3（P0-4）：真实投稿列表字段是 created / length / play / author / mid
  // fixture 结构来自 tests/fixtures/real/ 实机抓取的 vlist 字段集合。
  describe('real arc/search vlist fields', () => {
    const REAL_VLIST = {
      code: 0,
      data: {
        list: {
          vlist: [
            {
              aid: 123,
              bvid: 'BV1Test00001',
              title: '对话汉斯·季默！',
              created: 1750000000,
              length: '12:34',
              play: 123456,
              author: '影视飓风',
              mid: 946974,
              description: 'real description',
              typeid: 21,
              pic: 'https://i0.hdslb.com/bfs/archive/x.jpg',
              comment: 999,
              video_review: 88,
            },
          ],
        },
        page: { count: 934, pn: 1, ps: 30 },
      },
    };

    it('maps length → duration', () => {
      const list = normalizeVideoList(REAL_VLIST, { creatorId: 'c1' });
      expect(list).toHaveLength(1);
      expect(list[0]!.duration).toBe(12 * 60 + 34);
    });

    it('maps created → pubTime (no Date.now fallback)', () => {
      const list = normalizeVideoList(REAL_VLIST, { creatorId: 'c1' });
      expect(list[0]!.pubTime).toBe(new Date(1750000000 * 1000).toISOString());
      // 绝不能是"今天"
      expect(list[0]!.pubTime!.slice(0, 10)).not.toBe(new Date().toISOString().slice(0, 10));
    });

    it('maps play → views, author → authorName, mid → authorMid', () => {
      const list = normalizeVideoList(REAL_VLIST, { creatorId: 'c1' });
      expect(list[0]!.views).toBe(123456);
      expect(list[0]!.authorName).toBe('影视飓风');
      expect(list[0]!.authorMid).toBe(946974);
    });

    it('missing created/length → null, never today / 0s', () => {
      const raw = {
        code: 0,
        data: { list: { vlist: [{ aid: 1, bvid: 'BV1Test00002', title: 'no meta' }] } },
      };
      const list = normalizeVideoList(raw, { creatorId: 'c1' });
      expect(list[0]!.pubTime).toBeNull();
      expect(list[0]!.duration).toBeNull();
    });
  });
});

describe('parseDurationToSeconds', () => {
  it('number passes through', () => {
    expect(parseDurationToSeconds(123)).toBe(123);
    expect(parseDurationToSeconds(0)).toBe(0);
    // 负数不是"0 秒"，是无效输入 → null
    expect(parseDurationToSeconds(-1)).toBeNull();
  });
  it('numeric string parses', () => {
    expect(parseDurationToSeconds('123')).toBe(123);
    expect(parseDurationToSeconds('123.4')).toBe(123);
  });
  it('MM:SS parses', () => {
    expect(parseDurationToSeconds('5:30')).toBe(330);
    expect(parseDurationToSeconds('00:45')).toBe(45);
  });
  it('HH:MM:SS parses', () => {
    expect(parseDurationToSeconds('1:02:03')).toBe(3723);
  });
  // V0.1.3：garbage = 未知 → null（旧实现返回 0，制造出"全部 0s"的假数据）
  it('garbage returns null', () => {
    expect(parseDurationToSeconds('abc')).toBeNull();
    expect(parseDurationToSeconds(null)).toBeNull();
    expect(parseDurationToSeconds(undefined)).toBeNull();
    expect(parseDurationToSeconds({})).toBeNull();
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