import { describe, expect, it, vi } from 'vitest';
import { SearchCollector, normalizeSearchVideo, normalizeSearchVideoList, stripSearchHighlight, parseSearchDuration } from '@collectors/search-collector';

describe('stripSearchHighlight', () => {
  it('removes <em class="keyword">', () => {
    expect(stripSearchHighlight('<em class="keyword">ai</em> 工具')).toBe('ai 工具');
  });
  it('removes plain <em>', () => {
    expect(stripSearchHighlight('<em>foo</em>bar')).toBe('foobar');
  });
  it('returns empty for empty input', () => {
    expect(stripSearchHighlight('')).toBe('');
    expect(stripSearchHighlight(undefined as unknown as string)).toBe('');
  });
  it('strips nested tags', () => {
    expect(stripSearchHighlight('a<b>i</b>c')).toBe('aic');
  });
});

describe('parseSearchDuration', () => {
  it('parses MM:SS', () => {
    expect(parseSearchDuration('5:30')).toBe(330);
    expect(parseSearchDuration('00:45')).toBe(45);
  });
  it('parses HH:MM:SS', () => {
    expect(parseSearchDuration('1:02:03')).toBe(3723);
  });
  it('parses numeric string', () => {
    expect(parseSearchDuration('120')).toBe(120);
  });
  it('parses number', () => {
    expect(parseSearchDuration(120)).toBe(120);
  });
  // V0.1.3：garbage = 未知 → null（不再伪装成 0s）
  it('returns null on garbage', () => {
    expect(parseSearchDuration('abc')).toBeNull();
    expect(parseSearchDuration(null)).toBeNull();
  });
});

describe('normalizeSearchVideo', () => {
  // 真实 B 站搜索响应单条结构（来自 api.bilibili.com/x/web-interface/search/type?search_type=video）
  const raw = {
    bvid: 'BV1xxxxxxxxx',
    aid: 123456,
    title: '<em class="keyword">AI</em> 工具推荐 2024',
    description: '本期盘点 ...',
    pic: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
    pubdate: 1700000000,
    duration: '5:30',
    play: 12345,
    mid: 67890,
    author: '测试UP',
    tag: 'AI,工具,推荐',
  };

  it('happy path maps real search fields correctly', () => {
    const v = normalizeSearchVideo(raw);
    expect(v).not.toBeNull();
    if (!v) return;
    expect(v.bvid).toBe('BV1xxxxxxxxx');
    expect(v.title).toBe('AI 工具推荐 2024'); // HTML stripped
    expect(v.duration).toBe(330); // "5:30" → 330s
    expect(v.category).toBe(''); // 搜索接口不返回 tname
    expect(v.tags).toEqual(['AI', '工具', '推荐']);
    expect(v.cover).toBe('https://i0.hdslb.com/bfs/archive/abc.jpg');
    expect(v.source).toBe('bili-web');
    // V0.1.2（P0-4）：creatorId 不再是字面量 'search'，UP 与播放数据必须保留
    expect(v.creatorId).toBe('uid:67890');
    expect(v.authorName).toBe('测试UP');
    expect(v.authorMid).toBe(67890);
    expect(v.views).toBe(12345);
  });

  it('无 mid / 无 play 时不伪造数据（未知留空）', () => {
    const v = normalizeSearchVideo({ ...raw, mid: undefined, author: undefined, play: undefined });
    expect(v).not.toBeNull();
    expect(v?.creatorId).toBe('search');
    expect(v?.authorName).toBeUndefined();
    expect(v?.authorMid).toBeUndefined();
    expect(v?.views).toBeUndefined();
  });

  it('falls back to tag_list when tag missing', () => {
    const v = normalizeSearchVideo({ ...raw, tag: undefined, tag_list: ['A', 'B'] });
    expect(v?.tags).toEqual(['A', 'B']);
  });

  it('rejects invalid bvid', () => {
    expect(normalizeSearchVideo({ ...raw, bvid: 'INVALID' })).toBeNull();
  });

  it('rejects missing aid', () => {
    expect(normalizeSearchVideo({ ...raw, aid: undefined })).toBeNull();
  });

  it('rejects empty title after strip', () => {
    expect(normalizeSearchVideo({ ...raw, title: '<em></em>' })).toBeNull();
  });

  it('uses default cover if pic invalid URL', () => {
    const v = normalizeSearchVideo({ ...raw, pic: 'not-a-url' });
    expect(v?.cover).toBeUndefined();
  });

  it('truncates oversized title and description', () => {
    const longTitle = 'x'.repeat(1000);
    const longDesc = 'y'.repeat(10_000);
    const v = normalizeSearchVideo({ ...raw, title: longTitle, description: longDesc });
    expect(v?.title.length).toBe(500);
    expect(v?.description.length).toBe(5000);
  });
});

describe('normalizeSearchVideoList', () => {
  it('returns empty on empty input', () => {
    expect(normalizeSearchVideoList([])).toEqual([]);
    expect(normalizeSearchVideoList(null)).toEqual([]);
  });

  it('skips invalid items', () => {
    const list = normalizeSearchVideoList([
      { bvid: 'INVALID', aid: 1 },
      { bvid: 'BV1xxxxxxxxx', aid: 1, title: 'ok', duration: '1:00' },
    ]);
    expect(list).toHaveLength(1);
  });
});

describe('SearchCollector', () => {
  it('returns ok on real search response structure', async () => {
    // V0.1.1 修复：data.result.video[]，每项字段不同于 archive API
    const realResp = {
      code: 0,
      message: '0',
      ttl: 1,
      data: {
        page: 1,
        pagesize: 20,
        numResults: 100,
        numPages: 5,
        result: {
          video: [
            {
              bvid: 'BV1xxxxxxxxx',
              aid: 1,
              title: '<em class="keyword">ai</em> 工具',
              description: 'desc',
              pic: 'https://i0.hdslb.com/bfs/archive/x.jpg',
              pubdate: 1700000000,
              duration: '3:45',
              play: 100,
              mid: 99,
              author: 'up',
              tag: 'tag1,tag2',
            },
          ],
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(realResp), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    try {
      const c = new SearchCollector();
      const r = await c.collect({ targetId: 'ai' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toHaveLength(1);
      expect(r.data[0]!.title).toBe('ai 工具');
      expect(r.data[0]!.duration).toBe(225);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('returns error on search code != 0', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: -101, message: '鉴权失败' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    try {
      const c = new SearchCollector();
      const r = await c.collect({ targetId: 'ai' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('-101');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('empty keyword returns error', async () => {
    const c = new SearchCollector();
    const r = await c.collect({ targetId: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('empty');
  });
});