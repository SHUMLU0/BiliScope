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

  it('handles garbage duration as 0', () => {
    const raw = {
      code: 0,
      data: {
        vlist: [
          { bvid: 'BV1xxxxxxxxx', aid: 1, title: 't', duration: 'abc' },
        ],
      },
    };
    const list = normalizeVideoList(raw, { creatorId: 'c' });
    expect(list[0]!.duration).toBe(0);
  });
});

describe('parseDurationToSeconds', () => {
  it('number passes through', () => {
    expect(parseDurationToSeconds(123)).toBe(123);
    expect(parseDurationToSeconds(0)).toBe(0);
    expect(parseDurationToSeconds(-1)).toBe(0);
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
  it('garbage returns 0', () => {
    expect(parseDurationToSeconds('abc')).toBe(0);
    expect(parseDurationToSeconds(null)).toBe(0);
    expect(parseDurationToSeconds(undefined)).toBe(0);
    expect(parseDurationToSeconds({})).toBe(0);
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