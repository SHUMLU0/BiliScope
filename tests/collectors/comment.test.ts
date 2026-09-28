import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CommentCollector,
  buildCommentMainQuery,
  nextPagePaginationStr,
  firstPagePaginationStr,
  isPaginationStalled,
  type CommentCollectOptions,
} from '@collectors/comment-collector';
import { db, clearAll } from '@db/database';
import { commentRepo, videoRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { videoSchema } from '@models/video';
import { normalizeCommentPage, normalizeSubReplies } from '@normalizers/comment';
import * as wbi from '@utils/wbi';

// ── 真实 B 站一级评论响应形状（V0.2.1 · pagination_str 协议）───────────────────
// 一级：/x/v2/reply/wbi/main → data.replies + data.cursor.pagination_reply.next_offset
//       请求分页参数是 **pagination_str**，值形如 {"offset":"<next_offset>"}
// 二级：/x/v2/reply/reply   → data.replies（parent=root，dialog=root），用 pn/ps 页码分页

function reply(
  i: number,
  opts: {
    rcount?: number;
    ctime?: number;
    level?: number;
    mid?: number;
    content?: string;
    sex?: string;
    vipStatus?: number;
    location?: string;
    like?: number;
  } = {},
) {
  return {
    rpid: i,
    rpid_str: String(i),
    mid: opts.mid ?? 1000 + i,
    mid_str: String(opts.mid ?? 1000 + i),
    parent: 0,
    dialog: i,
    like: opts.like ?? 0,
    rcount: opts.rcount ?? 0,
    ctime: opts.ctime ?? 1700000000 + i,
    member: {
      uname: `u${i}`,
      sex: opts.sex,
      level_info: { current_level: opts.level ?? 0 },
      vip: { vipStatus: opts.vipStatus },
      location: opts.location,
    },
    content: { message: opts.content ?? `c${i}` },
  };
}

/** 构造一级响应；next_offset 是 JSON 字符串（真实协议），null 表示结束 */
function mainPage(opts: {
  replies: unknown[];
  all_count: number;
  is_end: boolean;
  next_offset: string | null;
  code?: number;
  message?: string;
}) {
  return {
    code: opts.code ?? 0,
    message: opts.message ?? '0',
    ttl: 1,
    data: {
      cursor: {
        is_end: opts.is_end,
        all_count: opts.all_count,
        pagination_reply: { next_offset: opts.next_offset, prev_offset: '' },
      },
      replies: opts.replies,
      hots: [],
    },
  };
}

/** 构造二级响应（pn/ps 分页；不含 cursor 依赖） */
function subPage(opts: { replies: unknown[] }) {
  return {
    code: 0,
    message: '0',
    ttl: 1,
    data: { page: { num: 1, size: 20, count: opts.replies.length }, replies: opts.replies },
  };
}

function subReply(root: number, i: number) {
  return {
    rpid: 100000 + i,
    rpid_str: String(100000 + i),
    root,
    parent: root,
    dialog: root,
    mid: 2000 + i,
    mid_str: String(2000 + i),
    like: 1,
    rcount: 0,
    ctime: 1700000500 + i,
    member: { uname: `sub${i}`, level_info: { current_level: 1 }, vip: {} },
    content: { message: `sub-${i}` },
  };
}

const BVID = 'BV1xx411c7m9';
const AID = 999;
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function seedVideo() {
  await db.videos.add(
    videoSchema.parse({
      id: newId('vd'),
      bvid: BVID,
      aid: AID,
      creatorId: 'cr_test',
      title: 't',
      description: '',
      cover: undefined,
      pubTime: nowIso(),
      duration: 10,
      category: '',
      tags: [],
      url: 'https://www.bilibili.com/video/BV1xx411c7m9',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: 'manual',
    }),
  );
}

/** 记录每次请求的 URL，便于断言协议逐页正确 */
let fetchHandler: ((url: string, init?: unknown) => Response) | null = null;
let requestUrls: string[] = [];
/** 真实 fetch 的引用；beforeEach 里被 mock 覆盖，afterEach 显式还原（E2E 依赖） */
let realFetch: typeof fetch | undefined;

function urls() {
  return requestUrls;
}
/** 取出第 n 次请求 URL 的 pagination_str 原始值 */
function paginationStrOf(n: number): string {
  return new URL(urls()[n]).searchParams.get('pagination_str') ?? '';
}

beforeEach(async () => {
  await clearAll();
  requestUrls = [];
  // 保存真实 fetch：globalThis.fetch 的直接赋值不会被 vi.restoreAllMocks() 还原，
  // 若不显式恢复，E2E（需要真实网络）会被这里的 mock 污染造成"幽灵失败"。
  realFetch = globalThis.fetch;
  // refreshWbi 抛错 → 走未签名降级分支，测试全程不触网、确定性
  vi.spyOn(wbi, 'refreshWbi').mockImplementation(async () => {
    throw new Error('test: wbi offline');
  });
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? '');
    requestUrls.push(url);
    return fetchHandler
      ? fetchHandler(url, init)
      : json(mainPage({ replies: [], all_count: 0, is_end: true, next_offset: null }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
  // 显式还原真实 fetch（vi.restoreAllMocks 管不到直接赋值）
  if (realFetch) globalThis.fetch = realFetch;
  fetchHandler = null;
});

function installFetch(handler: (url: string, init?: unknown) => Response) {
  fetchHandler = handler;
}

// ── P0-1 协议单元 ───────────────────────────────────────────────────────────

describe('P0-1 · pagination_str 协议构造', () => {
  it('firstPagePaginationStr 是 {"offset":""}', () => {
    expect(JSON.parse(firstPagePaginationStr())).toEqual({ offset: '' });
  });

  it('nextPagePaginationStr 把上一页 next_offset 原样放进 offset', () => {
    const next = '{"type":3,"direction":1,"data":{"cursor":20}}';
    const s = nextPagePaginationStr(next);
    expect(JSON.parse(s)).toEqual({ offset: next });
    // 不做二次解析：offset 仍是一个「字符串」而非被展开的对象
    expect(typeof (JSON.parse(s) as { offset: unknown }).offset).toBe('string');
  });

  it('isPaginationStalled 仅在 offset 重复且非空时为真', () => {
    expect(isPaginationStalled('', '')).toBe(false);
    expect(isPaginationStalled('A', 'B')).toBe(false);
    expect(isPaginationStalled('A', 'A')).toBe(true);
  });

  it('buildCommentMainQuery 产出 oid/type/mode/pagination_str/plat/seek_rpid/web_location，且不含 pagination_reply', async () => {
    const q = await buildCommentMainQuery(AID, 2, firstPagePaginationStr());
    const sp = new URLSearchParams(q);
    expect(sp.get('oid')).toBe(String(AID));
    expect(sp.get('type')).toBe('1');
    expect(sp.get('mode')).toBe('2');
    expect(sp.get('plat')).toBe('1');
    expect(sp.get('seek_rpid')).toBe('');
    expect(sp.get('web_location')).toBe('1315875');
    expect(JSON.parse(sp.get('pagination_str') ?? '{}')).toEqual({ offset: '' });
    // 关键：绝不能出现 pagination_reply 这个错误参数
    expect(sp.has('pagination_reply')).toBe(false);
  });

  it('mode 随排序切换：hot→3 / time→2', async () => {
    await seedVideo();
    installFetch(() =>
      json(mainPage({ replies: [reply(1)], all_count: 1, is_end: true, next_offset: null })),
    );
    const c = new CommentCollector();
    await c.collectComments(BVID, { sort: 'hot', tier: 'quick', depth: 'top' });
    expect(new URL(urls()[0]).searchParams.get('mode')).toBe('3');
    requestUrls = [];
    fetchHandler = () =>
      json(mainPage({ replies: [reply(1)], all_count: 1, is_end: true, next_offset: null }));
    await c.collectComments(BVID, { sort: 'time', tier: 'quick', depth: 'top' });
    expect(new URL(urls()[0]).searchParams.get('mode')).toBe('2');
  });
});

// ── P0-2 / P0-3 / P0-4 采集行为 ─────────────────────────────────────────────

describe('CommentCollector · V0.2.1 分页协议与不变量', () => {
  it('V0.2.2: 本地无 Video 时会自动 bootstrap（不再直接报 video not found）', async () => {
    // 未 seedVideo，但 view 接口正常 → 应自动补依赖并继续采集
    installFetch(() =>
      json(mainPage({ replies: [reply(1)], all_count: 1, is_end: true, next_offset: null })),
    );
    // 该用例的关注点：错误信息不再出现「video not found for bvid=」
    const c = new CommentCollector();
    const r = await c.collect({ targetId: BVID });
    if (!r.ok) {
      expect(r.error).not.toMatch(/video not found for bvid=/);
    }
  });

  it('P0-2: 第2页请求必须带 pagination_str，且 offset 来自第1页 next_offset；两页不同则全部入库', async () => {
    await seedVideo();
    const NEXT = '{"type":3,"direction":1,"data":{"cursor":20}}';
    installFetch((url) => {
      const sp = new URL(url).searchParams;
      const ps = JSON.parse(sp.get('pagination_str') ?? '{"offset":""}') as { offset: string };
      if (ps.offset === '') {
        return json(
          mainPage({
            replies: Array.from({ length: 20 }, (_, i) => reply(i + 1)),
            all_count: 45,
            is_end: false,
            next_offset: NEXT,
          }),
        );
      }
      if (ps.offset === NEXT) {
        return json(
          mainPage({
            replies: Array.from({ length: 25 }, (_, i) => reply(21 + i)),
            all_count: 45,
            is_end: true,
            next_offset: null,
          }),
        );
      }
      throw new Error(`unexpected pagination_str offset=${ps.offset}`);
    });

    const c = new CommentCollector();
    const opts: CommentCollectOptions = { sort: 'time', tier: 'standard', depth: 'top' };
    const r = await c.collectComments(BVID, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 协议断言：第 1 次无 offset，第 2 次 offset === 第1页 next_offset
    expect(urls().length).toBe(2);
    expect(JSON.parse(paginationStrOf(0))).toEqual({ offset: '' });
    expect(JSON.parse(paginationStrOf(1))).toEqual({ offset: NEXT });
    // 每次请求都不许出现 pagination_reply
    for (const u of urls()) expect(new URL(u).searchParams.has('pagination_reply')).toBe(false);

    // 结果断言
    expect(r.data).toHaveLength(45);
    expect(r.stats?.added).toBe(45);
    expect(r.stats?.pages).toBe(2);
    expect(r.stats?.fetched).toBe(45);
    expect(r.stats?.unique).toBe(45);
    expect(r.stats?.expectedTotal).toBe(45);
    expect(r.diagnostics?.paginationAdvanced).toBe(true);
    expect(r.diagnostics?.paginationStalled).not.toBe(true);

    const uniqueRpids = new Set(r.data.map((x) => x.rpidStr));
    expect(uniqueRpids.size).toBe(45);

    const v = await videoRepo.findByBvid(BVID);
    expect(v).toBeTruthy();
    if (!v) return;
    expect(await db.comments.where('videoId').equals(v.id).count()).toBe(45);
  });

  it('第11条回归：第1页只有3条但第2页其实有数据 → 绝不能停在3', async () => {
    await seedVideo();
    const NEXT = '{"type":3,"direction":1,"data":{"cursor":3}}';
    installFetch((url) => {
      const ps = JSON.parse(
        new URL(url).searchParams.get('pagination_str') ?? '{"offset":""}',
      ) as { offset: string };
      if (ps.offset === '') {
        // 第1页仅 3 条，但 is_end=false 且给出 next_offset
        return json(
          mainPage({
            replies: [reply(1), reply(2), reply(3)],
            all_count: 30,
            is_end: false,
            next_offset: NEXT,
          }),
        );
      }
      return json(
        mainPage({
          replies: Array.from({ length: 10 }, (_, i) => reply(4 + i)),
          all_count: 30,
          is_end: true,
          next_offset: null,
        }),
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 关键：必须继续翻到第2页，得到 13 条，而不是停在 3
    expect(urls().length).toBe(2);
    expect(r.data).toHaveLength(13);
    expect(r.data.length).toBeGreaterThan(3);
    expect(r.stats?.pages).toBe(2);
    expect(r.stats?.unique).toBe(13);
    expect(r.diagnostics?.paginationAdvanced).toBe(true);
  });

  it('P0-3: next_offset 不前进（服务端重复同一 offset）→ 停止并标记 paginationStalled，不循环烧请求', async () => {
    await seedVideo();
    const STUCK = '{"type":3,"direction":1,"data":{"cursor":20}}';
    let served = 0;
    installFetch(() => {
      served++;
      // 每次都返回新的一页数据但 next_offset 恒定不变 → 模拟游标卡死
      return json(
        mainPage({
          replies: Array.from({ length: 20 }, (_, i) => reply(served * 1000 + i)),
          all_count: 9999,
          is_end: false,
          next_offset: STUCK,
        }),
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 第1页 → next_offset=STUCK；第2页后 again STUCK → 判定卡住终止。最多 2 页，绝不无限循环
    expect(urls().length).toBeLessThanOrEqual(3);
    expect(r.diagnostics?.paginationStalled).toBe(true);
  });

  it('P0-3: 连续两页 rpid 完全重复 → duplicatePageDetected 并停止（跨页去重不靠此也能拦住）', async () => {
    await seedVideo();
    const NEXT = '{"type":3,"direction":1,"data":{"cursor":1}}';
    const NEXT2 = '{"type":3,"direction":1,"data":{"cursor":2}}';
    const pageReplies = [reply(1), reply(2), reply(3)];
    let call = 0;
    installFetch(() => {
      call++;
      if (call === 1) {
        return json(mainPage({ replies: pageReplies, all_count: 99, is_end: false, next_offset: NEXT }));
      }
      // 第2页返回与第1页完全相同的 rpid 集合，但给一个"前进"的 offset 以绕过不变量1
      return json(
        mainPage({ replies: pageReplies, all_count: 99, is_end: false, next_offset: NEXT2 }),
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics?.duplicatePageDetected).toBe(true);
    expect(r.data).toHaveLength(3); // 去重后仍只有 3 条
    expect(r.stats?.fetched).toBe(6); // 原始抓取 3+3
    expect(r.stats?.unique).toBe(3);
    expect(urls().length).toBe(2); // 立即停止，不再打第 3 页
  });

  it('P0-4: 服务器重复页不会用重复数据填满档位（fetched≠unique，unique 才入库）', async () => {
    await seedVideo();
    const A = '{"type":3,"direction":1,"data":{"cursor":1}}';
    // 第1页 10 条；第2页 10 条（前 5 条与第1页重叠、后 5 条新增）→ fetched 20 / unique 15
    // 交错构造，保证第2页"本页唯一新增 = 5 > 0"，不会被 0-new 不变量提前终止。
    const interleaved = [1, 11, 2, 12, 3, 13, 4, 14, 5, 15];
    installFetch((url) => {
      const off = JSON.parse(
        new URL(url).searchParams.get('pagination_str') ?? '{"offset":""}',
      ).offset as string;
      if (off === '') {
        return json(
          mainPage({
            replies: Array.from({ length: 10 }, (_, i) => reply(i + 1)),
            all_count: 20,
            is_end: false,
            next_offset: A,
          }),
        );
      }
      return json(
        mainPage({
          replies: interleaved.map((n) => reply(n)),
          all_count: 20,
          is_end: true,
          next_offset: null,
        }),
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'quick', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats?.fetched).toBe(20); // 10 + 10 原始（重复也被计入 fetched）
    expect(r.stats?.unique).toBe(15); // 去重后 15 唯一
    expect(r.data).toHaveLength(15);
    const set = new Set(r.data.map((x) => x.rpidStr));
    expect(set.size).toBe(15);
  });

  it('tier limit 生效（quick=50）：取满即止，且不会为了翻页多打请求', async () => {
    await seedVideo();
    installFetch(() =>
      json(
        mainPage({
          replies: Array.from({ length: 60 }, (_, i) => reply(i + 1)),
          all_count: 60,
          is_end: false,
          next_offset: '{"type":3,"direction":1,"data":{"cursor":60}}',
        }),
      ),
    );
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'quick', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(50);
    expect(r.stats?.added).toBe(50);
    expect(r.stats?.expectedTotal).toBe(60);
    expect(urls().length).toBe(1);
  });

  it('maxPages 上限 → partial，不伪装完整', async () => {
    await seedVideo();
    let n = 0;
    installFetch(() => {
      n++;
      return json(
        mainPage({
          replies: [reply(n)],
          all_count: 1000,
          is_end: false,
          next_offset: `{"type":3,"direction":1,"data":{"cursor":${n}}}`,
        }),
      );
    });
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'deep', depth: 'top', maxPages: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(urls().length).toBe(3);
    expect(r.diagnostics?.partial).toBe(true);
    expect(r.stats?.pages).toBe(3);
  });
});

// ── P0-5 二级回复 pn/ps 分页 ────────────────────────────────────────────────

describe('CommentCollector · P0-5 二级回复 pn/ps 分页', () => {
  it('二级回复用 pn=1,2,3 翻页，末页 < ps 自动停止，且使用 root 参数', async () => {
    await seedVideo();
    installFetch((url) => {
      const u = new URL(url);
      if (u.pathname.includes('/x/v2/reply/reply')) {
        const pn = Number(u.searchParams.get('pn'));
        expect(u.searchParams.get('ps')).toBe('20');
        expect(u.searchParams.has('pagination_str')).toBe(false); // 二级不用 cursor
        const root = Number(u.searchParams.get('root'));
        if (pn === 1) return json(subPage({ replies: Array.from({ length: 20 }, (_, i) => subReply(root, i + 1)) }));
        if (pn === 2) return json(subPage({ replies: Array.from({ length: 20 }, (_, i) => subReply(root, i + 21)) }));
        return json(subPage({ replies: Array.from({ length: 7 }, (_, i) => subReply(root, i + 41)) }));
      }
      // 一级：1 条，rcount=47
      return json(
        mainPage({ replies: [reply(1, { rcount: 47 })], all_count: 1, is_end: true, next_offset: null }),
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'deep', depth: 'deep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const top = r.data.filter((x) => x.replyLevel === 1);
    const sub = r.data.filter((x) => x.replyLevel === 2);
    expect(top).toHaveLength(1);
    expect(sub).toHaveLength(47); // 20 + 20 + 7
    // 二级必须保留 rootRpid / parentRpid / rootRpidStr
    for (const s of sub) {
      expect(s.rootRpid).toBe(1);
      expect(s.parentRpid).toBe(1);
      expect(s.rootRpidStr).toBe('1');
    }
    // 二级请求页码序列：1,2,3
    const subPns = urls()
      .filter((u) => u.includes('/x/v2/reply/reply'))
      .map((u) => Number(new URL(u).searchParams.get('pn')));
    expect(subPns).toEqual([1, 2, 3]);
  });

  it('二级回复重复 rpid 会被去重（seenRpidStr）', async () => {
    await seedVideo();
    installFetch((url) => {
      const u = new URL(url);
      if (u.pathname.includes('/x/v2/reply/reply')) {
        const pn = Number(u.searchParams.get('pn'));
        const root = Number(u.searchParams.get('root'));
        // 两页都返回同样的 20 条（模拟重复）
        void pn;
        return json(subPage({ replies: Array.from({ length: 20 }, (_, i) => subReply(root, i + 1)) }));
      }
      return json(
        mainPage({ replies: [reply(1, { rcount: 40 })], all_count: 1, is_end: true, next_offset: null }),
      );
    });
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'deep', depth: 'deep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = r.data.filter((x) => x.replyLevel === 2);
    expect(sub).toHaveLength(20); // 重复被去掉，不是 40
    expect(r.diagnostics?.duplicatePageDetected).toBe(true);
  });
});

// ── P0-D 环境受限 / 真实性区分 ───────────────────────────────────────────────

describe('CommentCollector · 真实性区分 (P0-D)', () => {
  it('environment-limited (code=-412) 返回 ok:false 带 diagnostics，绝不伪造成功', async () => {
    await seedVideo();
    installFetch(() => json({ code: -412, message: '请求被拦截', data: null }));
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.diagnostics?.environmentLimited).toBe(true);
    expect(r.diagnostics?.biliCode).toBe(-412);
    const v = await videoRepo.findByBvid(BVID);
    if (v) expect(await db.comments.where('videoId').equals(v.id).count()).toBe(0);
  });

  it('真的只有 3 条（is_end=true）→ ok:true 且 3 条，不标 environmentLimited', async () => {
    await seedVideo();
    installFetch(() =>
      json(mainPage({ replies: [reply(1), reply(2), reply(3)], all_count: 3, is_end: true, next_offset: null })),
    );
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(3);
    expect(r.stats?.expectedTotal).toBe(3);
    expect(r.diagnostics?.environmentLimited).not.toBe(true);
  });

  it('第1页成功、第2页被风控 → ok:true（部分完成）但 environmentLimited=true，绝不称"完整"', async () => {
    await seedVideo();
    const NEXT = '{"type":3,"direction":1,"data":{"cursor":20}}';
    installFetch((url) => {
      const off = JSON.parse(
        new URL(url).searchParams.get('pagination_str') ?? '{"offset":""}',
      ).offset as string;
      if (off === '') {
        return json(
          mainPage({ replies: Array.from({ length: 20 }, (_, i) => reply(i + 1)), all_count: 200, is_end: false, next_offset: NEXT }),
        );
      }
      return json({ code: -412, message: '请求被拦截', data: null });
    });
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(20); // 拿到了部分
    expect(r.diagnostics?.environmentLimited).toBe(true); // 但明确标记不完整
    expect(r.stats?.pages).toBe(2);
  });
});

// ── P0-C 字段 / P1-8 字符串关系键 / P1-10 可空互动字段 ─────────────────────────

describe('CommentCollector · 字段契约', () => {
  it('暴露字符串 ID、画像字段与字符串关系键 (P0-C / P1-8)', async () => {
    await seedVideo();
    installFetch(() =>
      json(
        mainPage({
          replies: [reply(1, { sex: '男', vipStatus: 1, location: '北京', level: 5, like: 42, content: '你好世界' })],
          all_count: 1,
          is_end: true,
          next_offset: null,
        }),
      ),
    );
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cm = r.data[0];
    expect(cm.rpidStr).toBe('1');
    expect(cm.midStr).toBe('1001');
    expect(cm.rootRpidStr).toBe('1');
    expect(cm.dialogStr).toBe('1');
    expect(cm.sex).toBe('男');
    expect(cm.vipStatus).toBe(1);
    expect(cm.location).toBe('北京');
    expect(cm.level).toBe(5);
    expect(cm.like).toBe(42);
    expect(cm.content).toBe('你好世界');
  });

  it('P1-10: 缺失的画像字段不伪装成 "未知"，location 从 reply_control 提取', async () => {
    await seedVideo();
    installFetch(() =>
      json(
        mainPage({
          replies: [
            {
              ...reply(1),
              // member 无 location；只在 reply_control 里给出 IP 属地
              member: { uname: 'u', level_info: { current_level: 2 }, vip: {} },
              reply_control: { location: 'IP属地：北京' },
            },
            { ...reply(2), member: { uname: 'u2', level_info: { current_level: 1 }, vip: {} } },
          ],
          all_count: 2,
          is_end: true,
          next_offset: null,
        }),
      ),
    );
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.location).toBe('北京'); // 从 reply_control 提取，去前缀
    expect(r.data[1]!.location).toBeUndefined(); // 缺失即 undefined，不是 '未知'、不是 0
  });
});

// ── P0-6 真实 fixture 全链路（response → normalizer → collector → repo → Dexie）──

describe('P0-6 · 真实 fixture 全链路', () => {
  const fx = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(__dirname, `../fixtures/real/${name}`), 'utf-8'));

  it('fixture page1 经 normalizer 解析出真实字段与 next_offset', () => {
    const p1 = normalizeCommentPage({ videoId: 'v1', raw: fx('comment-main-page1.json') });
    expect(p1.ok).toBe(true);
    expect(p1.comments).toHaveLength(3);
    expect(p1.total).toBe(137);
    expect(p1.hasMore).toBe(true);
    // next_offset 是 JSON 字符串
    expect(typeof p1.nextOffset).toBe('string');
    expect(JSON.parse(p1.nextOffset!).data.cursor).toBe(20);
    const c0 = p1.comments[0]!;
    expect(c0.rpidStr.length).toBeGreaterThan(0);
    expect(c0.location).toBe('北京'); // 从 reply_control 提取
    expect(c0.like).toBe(328);
    expect(c0.replyLevel).toBe(1);
  });

  it('fixture 两级页 offsets 串联：page2 的 prev_offset 与 page1 的 next_offset 对应', () => {
    const p1 = normalizeCommentPage({ videoId: 'v1', raw: fx('comment-main-page1.json') });
    const p2 = normalizeCommentPage({ videoId: 'v1', raw: fx('comment-main-page2.json') });
    expect(p2.hasMore).toBe(false);
    expect(p2.nextOffset).toBeNull();
    // page1 的 next_offset 与 page2 的 prev_offset 是同一游标（同一 JSON 结构）
    expect(JSON.parse(p1.nextOffset!).data.cursor).toBe(20);
    const p1Keys = new Set(p1.comments.map((c) => c.rpidStr));
    for (const c of p2.comments) expect(p1Keys.has(c.rpidStr)).toBe(false); // 两页无重复
  });

  it('fixture 经完整 collector → repository → Dexie 落库', async () => {
    await seedVideo();
    const p1 = fx('comment-main-page1.json');
    const p2 = fx('comment-main-page2.json');
    const p1Next = (JSON.parse(JSON.stringify(p1)) as { data: { cursor: { pagination_reply: { next_offset: string } } } })
      .data.cursor.pagination_reply.next_offset;
    installFetch((url) => {
      const off = JSON.parse(
        new URL(url).searchParams.get('pagination_str') ?? '{"offset":""}',
      ).offset as string;
      return json(off === '' ? p1 : p2);
    });
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(paginationStrOf(1)).offset).toBe(p1Next);
    expect(r.data).toHaveLength(5); // 3 + 2
    const v = await videoRepo.findByBvid(BVID);
    expect(v).toBeTruthy();
    if (!v) return;
    const stored = await db.comments.where('videoId').equals(v.id).toArray();
    expect(stored).toHaveLength(5);
    // 落库后仍能按字符串关系键定位
    expect(stored.every((s) => s.rpidStr.length > 0)).toBe(true);
  });

  it('fixture 二级回复：page1(20条,未到头) + page2(3条,到头) → 23 条', async () => {
    await seedVideo();
    const sp1 = fx('comment-reply-page1.json');
    const sp2 = fx('comment-reply-page2.json');
    installFetch((url) => {
      const u = new URL(url);
      if (u.pathname.includes('/x/v2/reply/reply')) {
        return json(Number(u.searchParams.get('pn')) === 1 ? sp1 : sp2);
      }
      return json(mainPage({ replies: [reply(1, { rcount: 23 })], all_count: 1, is_end: true, next_offset: null }));
    });
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'deep', depth: 'deep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.filter((x) => x.replyLevel === 2)).toHaveLength(23);
  });

  it('二级 fixture 的 root/parent 被映射为 rootRpidStr/parentRpidStr', () => {
    const sp = normalizeSubReplies({
      videoId: 'v1',
      rootRpid: Number((fx('comment-reply-page1.json') as { data: { replies: [{ root: number }] } }).data.replies[0].root),
      rootRpidStr: String((fx('comment-reply-page1.json') as { data: { replies: [{ root: number }] } }).data.replies[0].root),
      raw: fx('comment-reply-page1.json'),
    });
    expect(sp.ok).toBe(true);
    expect(sp.total).toBe(20); // 本页原始条数（= ps → 未到头）
    expect(sp.comments).toHaveLength(20);
    for (const c of sp.comments) {
      expect(c.replyLevel).toBe(2);
      expect(c.parentRpidStr).toBe(c.rootRpidStr);
      expect(c.rootRpidStr.length).toBeGreaterThan(0);
    }
  });
});

// ── P1-9 Repository 互动字段更新 ────────────────────────────────────────────

describe('P1-9 · 评论互动字段更新语义', () => {
  const cm = (over: Partial<Parameters<typeof commentRepo.bulkAdd>[0][number]>) => ({
    id: newId('cm'),
    videoId: 'v1',
    rpid: 1,
    rpidStr: '1',
    mid: 10,
    midStr: '10',
    rootRpid: 0,
    parentRpid: 0,
    dialog: 1,
    replyLevel: 1 as const,
    rootRpidStr: '1',
    parentRpidStr: '',
    dialogStr: '1',
    like: 0,
    replyCount: 0,
    ctime: 1000,
    uname: 'u',
    content: 'c',
    level: 0,
    source: 'wbi-main' as const,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  });

  it('首次 bulkAdd → added；字段全同 → unchanged', async () => {
    await clearAll();
    const a = cm({});
    const r1 = await commentRepo.bulkAdd([a]);
    expect(r1.added).toBe(1);
    const r2 = await commentRepo.bulkAdd([cm({})]);
    expect(r2.added).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  it('互动字段（like/replyCount/location）变化 → updated，且保留 id / createdAt', async () => {
    await clearAll();
    const first = cm({ like: 1, replyCount: 0 });
    await commentRepo.bulkAdd([first]);
    const storedBefore = await db.comments.where('videoId').equals('v1').first();
    expect(storedBefore).toBeTruthy();
    if (!storedBefore) return;

    const r = await commentRepo.bulkAdd([
      cm({ like: 999, replyCount: 5, location: '北京', id: 'different-id' }),
    ]);
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);
    const stored = await db.comments.where('videoId').equals('v1').first();
    expect(stored?.like).toBe(999);
    expect(stored?.replyCount).toBe(5);
    expect(stored?.location).toBe('北京');
    // 主键与首次采集时间保留
    expect(stored?.id).toBe(storedBefore.id);
    expect(stored?.createdAt).toBe(storedBefore.createdAt);
  });

  it('大 rpidStr 精度：两个不同的超大 rpid 不会被判为同一条', async () => {
    await clearAll();
    const big1 = '9007199254740993';
    const big2 = '9007199254740995';
    const r = await commentRepo.bulkAdd([
      cm({ rpidStr: big1, rpid: Number(big1), mid: 1, midStr: '1' }),
      cm({ rpidStr: big2, rpid: Number(big2), mid: 1, midStr: '1' }),
    ]);
    // Number(big1) 与 Number(big2) 相同，但 rpidStr 不同 → 必须算作两条
    expect(r.added).toBe(2);
    const count = await db.comments.where('videoId').equals('v1').count();
    expect(count).toBe(2);
  });
});

// ── 真实 E2E（默认关闭，RUN_REAL_E2E=1 时运行）────────────────────────────────

describe('CommentCollector · real E2E (gated)', () => {
  // 该用例只在 RUN_REAL_E2E=1 时运行；结果必须如实记录：
  //   REAL_API_PASS     —— 拿到真实评论（unique>0 且无环境受限/未到档位上限）
  //   REAL_API_ENV_LIMIT—— 命中风控/环境受限（-412/-509 等）
  //   REAL_API_FAIL     —— 其他失败
  it.skipIf(!process.env.RUN_REAL_E2E)(
    'BV17u411E7UK: 先取真实 aid，再 standard=200/depth=top/sort=time，区分真数据 vs 环境受限',
    async () => {
      // E2E 必须打真实网络：撤销全部 mock 与 fetch 拦截（含 refreshWbi 离线桩）
      vi.restoreAllMocks();
      if (realFetch) globalThis.fetch = realFetch;
      fetchHandler = null;
      // 清掉 DB 中可能残留的同名视频，避免复用旧数据造成"幽灵成功"
      const stale = await db.videos.where('bvid').equals('BV17u411E7UK').toArray();
      for (const s of stale) await db.videos.delete(s.id);
      const viewRes = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV17u411E7UK', {
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
      });
      const view = (await viewRes.json()) as { data?: { aid?: number; title?: string } };
      expect(view.data?.aid).toBeTruthy();
      const aid = view.data!.aid!;
      await db.videos.add(
        videoSchema.parse({
          id: newId('vd'),
          bvid: 'BV17u411E7UK',
          aid,
          creatorId: 'cr_e2e',
          title: view.data?.title ?? 't',
          description: '',
          cover: undefined,
          pubTime: nowIso(),
          duration: 0,
          category: '',
          tags: [],
          url: 'https://www.bilibili.com/video/BV17u411E7UK',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          source: 'manual',
        }),
      );

      const c = new CommentCollector();
      const r = await c.collectComments('BV17u411E7UK', { sort: 'time', tier: 'standard', depth: 'top' });
      // eslint-disable-next-line no-console
      console.log('[REAL E2E]', JSON.stringify({ ok: r.ok, stats: r.ok ? r.stats : undefined, diagnostics: r.diagnostics }));
      if (r.ok) {
        expect(r.data.length).toBeGreaterThan(0);
      } else {
        expect(r.diagnostics?.environmentLimited).toBe(true);
      }
    },
    120_000,
  );
});
