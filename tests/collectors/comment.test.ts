import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentCollector, type CommentCollectOptions } from '@collectors/comment-collector';
import { db, clearAll } from '@db/database';
import { videoRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { videoSchema } from '@models/video';
import * as wbi from '@utils/wbi';

// ── 真实 B 站 reply 接口响应形状（V0.2 · 游标分页）────────────────────────────
// 一级：/x/v2/reply/wbi/main → data.replies + data.cursor.{all_count,is_end,pagination_reply.next_offset}
// 二级：/x/v2/reply/reply   → data.replies（parent=root，dialog=root）

function reply(i: number, opts: {
  rcount?: number;
  ctime?: number;
  level?: number;
  mid?: number;
  content?: string;
  sex?: string;
  vipStatus?: number;
  location?: string;
  like?: number;
} = {}) {
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
    data: {
      cursor: {
        all_count: opts.all_count,
        is_end: opts.is_end,
        pagination_reply: { next_offset: opts.next_offset },
      },
      replies: opts.replies,
      hots: [],
    },
  };
}

function subPage(opts: { root: number; replies: unknown[]; is_end: boolean; next_offset: string | null }) {
  return {
    code: 0,
    message: '0',
    data: {
      cursor: { all_count: 0, is_end: opts.is_end, pagination_reply: { next_offset: opts.next_offset } },
      replies: opts.replies,
    },
  };
}

function subReply(root: number, i: number) {
  return {
    rpid: 100000 + i,
    rpid_str: String(100000 + i),
    mid: 2000 + i,
    mid_str: String(2000 + i),
    parent: root,
    dialog: root,
    like: 1,
    rcount: 0,
    ctime: 1700000500 + i,
    member: { uname: `sub${i}`, level_info: { current_level: 1 }, vip: {}, location: undefined },
    content: { message: `sub-${i}` },
  };
}

const BVID = 'BV1xx411c7m9';
const AID = 999;

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

/**
 * 会话级 fetch 拦截：根据 URL 路径 + 游标区分一级 / 二级回复。
 * 由每个用例通过 `installFetch(handler)` 覆盖。
 */
let fetchHandler: ((url: string, init?: unknown) => Response) | null = null;
beforeEach(async () => {
  await clearAll();
  // 让 refreshWbi 抛错 → 触发 collector 的未签名降级分支，测试全程不触网、确定性。
  vi.spyOn(wbi, 'refreshWbi').mockImplementation(async () => {
    throw new Error('test: wbi offline');
  });
  globalThis.fetch = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? '');
    const body = fetchHandler ? fetchHandler(url, _init) : new Response(JSON.stringify(mainPage({ replies: [], all_count: 0, is_end: true, next_offset: null })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return body;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function installFetch(handler: (url: string, init?: unknown) => Response) {
  fetchHandler = handler;
}

describe('CommentCollector · V0.2 游标分页 (P0-A/B/C/D)', () => {
  it('requires video to be in DB', async () => {
    const c = new CommentCollector();
    const r = await c.collect({ targetId: BVID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/video not found/);
  });

  it('multi-page cursor pagination: collects all pages until is_end, not just first', async () => {
    await seedVideo();
    // 第 1 页：20 条，all_count=45，未结束，next_offset="off2"
    // 第 2 页：25 条，all_count=45，结束
    installFetch((url) => {
      const u = new URL(url);
      const off = u.searchParams.get('pagination_reply') ?? '';
      if (off === '' || off === '0') {
        return new Response(
          JSON.stringify(
            mainPage({ replies: Array.from({ length: 20 }, (_, i) => reply(i + 1)), all_count: 45, is_end: false, next_offset: 'off2' }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify(
          mainPage({ replies: Array.from({ length: 25 }, (_, i) => reply(21 + i)), all_count: 45, is_end: true, next_offset: null }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const c = new CommentCollector();
    const opts: CommentCollectOptions = { sort: 'time', tier: 'standard', depth: 'top' };
    const r = await c.collectComments(BVID, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(45);
    expect(r.stats?.added).toBe(45);
    expect(r.stats?.unchanged).toBe(0);
    expect(r.stats?.pages).toBe(2);
    expect(r.stats?.expectedTotal).toBe(45);
    expect(r.diagnostics?.environmentLimited).not.toBe(true);

    const v = await videoRepo.findByBvid(BVID);
    expect(v).toBeTruthy();
    if (!v) return;
    const count = await db.comments.where('videoId').equals(v.id).count();
    expect(count).toBe(45);

    // 重复采集：数据不变，added=0，unchanged=45，绝不重复入库
    const r2 = await c.collectComments(BVID, opts);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data).toHaveLength(45);
    expect(r2.stats?.added).toBe(0);
    expect(r2.stats?.unchanged).toBe(45);
    const after = await db.comments.where('videoId').equals(v.id).count();
    expect(after).toBe(45);
  });

  it('tier limit is respected (quick=50): stops after enough, never hardcodes pn<=3', async () => {
    await seedVideo();
    installFetch(() =>
      new Response(
        JSON.stringify(
          mainPage({ replies: Array.from({ length: 60 }, (_, i) => reply(i + 1)), all_count: 60, is_end: false, next_offset: 'off2' }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'quick', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(50); // quick 档位上限
    expect(r.stats?.added).toBe(50);
    expect(r.stats?.expectedTotal).toBe(60); // 声明总数仍上报
    // 只发起了 1 次请求（达到档位即止，不会为了翻页而多打）
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
  });

  it('depth mode expands sub-replies for top-level comments (P0-B)', async () => {
    await seedVideo();
    installFetch((url) => {
      if (url.includes('/x/v2/reply/reply')) {
        const u = new URL(url);
        const root = Number(u.searchParams.get('root'));
        // 每个根评论返回 2 条二级回复
        return new Response(
          JSON.stringify(subPage({ root, replies: [subReply(root, 1), subReply(root, 2)], is_end: true, next_offset: null })),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // 一级：3 条，每条 rcount=2
      return new Response(
        JSON.stringify(
          mainPage({
            replies: [reply(1, { rcount: 2 }), reply(2, { rcount: 2 }), reply(3, { rcount: 2 })],
            all_count: 3,
            is_end: true,
            next_offset: null,
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'deep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(9); // 3 一级 + 3*2 二级
    const top = r.data.filter((x) => x.replyLevel === 1);
    const sub = r.data.filter((x) => x.replyLevel === 2);
    expect(top).toHaveLength(3);
    expect(sub).toHaveLength(6);
    // 二级回复必须保留 rootRpid / parentRpid
    for (const s of sub) {
      expect(s.rootRpid).toBeGreaterThan(0);
      expect(s.parentRpid).toBe(s.rootRpid);
    }
  });

  it('environment-limited (code=-412) returns ok:false with diagnostics — never fakes success (P0-D)', async () => {
    await seedVideo();
    installFetch(() =>
      new Response(
        JSON.stringify({ code: -412, message: '请求被拦截', data: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryable).toBe(true);
    expect(r.diagnostics?.environmentLimited).toBe(true);
    expect(r.diagnostics?.biliCode).toBe(-412);
    // 数据库不应被写入任何伪造数据
    const v = await videoRepo.findByBvid(BVID);
    if (v) {
      const count = await db.comments.where('videoId').equals(v.id).count();
      expect(count).toBe(0);
    }
  });

  it('distinguishes "really only 3 comments" (ok + 3, NOT environment-limited) from "limited to 3"', async () => {
    await seedVideo();
    installFetch(() =>
      new Response(
        JSON.stringify(
          mainPage({
            replies: [reply(1), reply(2), reply(3)],
            all_count: 3,
            is_end: true,
            next_offset: null,
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(3);
    expect(r.stats?.expectedTotal).toBe(3);
    expect(r.diagnostics?.environmentLimited).not.toBe(true);
    expect(r.stats?.added).toBe(3);
  });

  it('exposes string IDs and profile fields per P0-C', async () => {
    await seedVideo();
    installFetch(() =>
      new Response(
        JSON.stringify(
          mainPage({
            replies: [
              reply(1, { sex: '男', vipStatus: 1, location: '北京', level: 5, like: 42, content: '你好世界' }),
            ],
            all_count: 1,
            is_end: true,
            next_offset: null,
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const c = new CommentCollector();
    const r = await c.collectComments(BVID, { sort: 'time', tier: 'standard', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cm = r.data[0];
    expect(cm.rpidStr).toBe('1');
    expect(cm.midStr).toBe('1001');
    expect(cm.sex).toBe('男');
    expect(cm.vipStatus).toBe(1);
    expect(cm.location).toBe('北京');
    expect(cm.level).toBe(5);
    expect(cm.like).toBe(42);
    expect(cm.content).toBe('你好世界');
  });
});

// ── 真实 E2E（默认关闭，仅当 RUN_REAL_E2E=1 时运行）─────────────────────────
describe('CommentCollector · real E2E (gated)', () => {
  it.skipIf(!process.env.RUN_REAL_E2E)(
    'BV1J7hE6aEDQ: real network distinguishes real-data vs environment-limited',
    async () => {
      // 恢复真实 WBI，走真实签名链路
      vi.restoreAllMocks();
      const viewRes = await fetch(
        'https://api.bilibili.com/x/web-interface/view?bvid=BV1J7hE6aEDQ',
        { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' } },
      );
      const view = (await viewRes.json()) as { data?: { aid?: number; title?: string } };
      expect(view.data?.aid).toBeTruthy();
      const aid = view.data!.aid!;
      await db.videos.add(
        videoSchema.parse({
          id: newId('vd'),
          bvid: 'BV1J7hE6aEDQ',
          aid,
          creatorId: 'cr_e2e',
          title: view.data?.title ?? 't',
          description: '',
          cover: undefined,
          pubTime: nowIso(),
          duration: 0,
          category: '',
          tags: [],
          url: 'https://www.bilibili.com/video/BV1J7hE6aEDQ',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          source: 'manual',
        }),
      );

      const c = new CommentCollector();
      const r = await c.collectComments('BV1J7hE6aEDQ', { sort: 'time', tier: 'quick', depth: 'top' }, undefined);
      // 绝不伪装：要么成功拿到数据，要么明确 environmentLimited
      if (r.ok) {
        expect(r.data.length).toBeGreaterThan(0);
        expect(r.diagnostics?.environmentLimited).not.toBe(true);
      } else {
        expect(r.diagnostics?.environmentLimited).toBe(true);
      }
    },
    60_000,
  );
});
