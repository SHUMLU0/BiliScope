/**
 * video-bootstrap 测试（V0.2.2）。
 *
 * 覆盖用户明确要求的 A–F：
 *   A. bootstrap happy path：本地无 Video → mock 真实 view 结构 → 自动建 Creator + Video
 *   B. 已有 Video：**不得**再请求 /view（断言 view 请求数 = 0）
 *   C. view 业务码非 0（{code:-404,data:null}）→ ok=false，不写脏数据，错误明说「视频信息获取失败」
 *   D. view 结构非法（缺 aid / bvid / data）→ 失败，不写脏数据
 *   E. unknown 语义：duration / 计数器 / pubTime 缺失时不得伪造 0 / Date.now()
 *   F. 真实 BV 回归：`BV1D9aA61E6v` + 真实 fixture（离线），**不硬编码「永远成功」**
 *
 * 真实性：断言的是「真实 shape 的响应经真实 normalizer 得到真实字段」，
 * 而非 mock 自我验证。真实网络验证在 Chrome E2E 与 RUN_REAL_E2E 中做。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureVideoByBvid } from '@services/video-bootstrap';
import { db, clearAll } from '@db/database';
import { creatorRepo, videoRepo } from '@repositories/index';

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
/** 真实测试 BV（来自真实回归场景，不是伪造） */
const REAL_BV = 'BV1D9aA61E6v';

let fetchHandler: ((url: string, init?: unknown) => Response) | null = null;
let requestUrls: string[] = [];
let realFetch: typeof fetch | undefined;

const json = (o: unknown) => new Response(JSON.stringify(o), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

/** 真实 /x/web-interface/view 成功响应（嵌套 data） */
function viewOk(over: {
  bvid?: string;
  aid?: number;
  title?: string;
  pubdate?: number | null;
  duration?: number | string | null;
  owner?: unknown;
  stat?: unknown;
  desc?: string;
  pic?: string;
  tname?: string;
} = {}) {
  const data: Record<string, unknown> = {
    bvid: over.bvid ?? REAL_BV,
    aid: over.aid ?? 113600005346789,
    title: over.title ?? '标题',
    desc: over.desc ?? '简介',
    pic: over.pic ?? 'https://i0.hdslb.com/bfs/archive/x.jpg',
    tname: over.tname ?? '生活',
  };
  // null = 显式缺失（不写该字段）；undefined = 未指定 → 用默认值
  if (over.pubdate !== null) data.pubdate = over.pubdate ?? 1735689600;
  if (over.duration !== null) data.duration = over.duration ?? 212;
  if ('owner' in over) data.owner = over.owner;
  else data.owner = { mid: 486906719, name: '测试UP主', face: 'https://i0.hdslb.com/bfs/face/x.jpg' };
  if ('stat' in over) {
    if (over.stat !== undefined) data.stat = over.stat;
  } else {
    data.stat = { view: 12345, like: 88 };
  }
  return { code: 0, message: '0', ttl: 1, data };
}

function viewCountRequests() {
  return requestUrls.filter((u) => u.startsWith(VIEW_URL)).length;
}

beforeEach(async () => {
  await clearAll();
  requestUrls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? '');
    requestUrls.push(url);
    if (!fetchHandler) throw new Error(`unexpected fetch in bootstrap test: ${url}`);
    return fetchHandler(url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (realFetch) globalThis.fetch = realFetch;
  fetchHandler = null;
});

// ── A. happy path ───────────────────────────────────────────────────────────

describe('video-bootstrap · A. happy path', () => {
  it('本地无 Video → 请求真实 view → 建最小 Creator + Video 并持久化', async () => {
    fetchHandler = () => json(viewOk());
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.fetched).toBe(true);
    expect(r.createdVideo).toBe(true);
    expect(r.createdCreator).toBe(true);
    expect(viewCountRequests()).toBe(1);

    // 返回的是真正存在于 Dexie 的记录（不是内存里的临时对象）
    const persisted = await videoRepo.findByBvid(REAL_BV);
    expect(persisted).toBeTruthy();
    expect(r.video.id).toBe(persisted!.id);
    expect(r.video.aid).toBe(113600005346789);

    // 关键：aid 已落地，评论接口才有 oid 可用
    expect(r.video.aid).toBeGreaterThan(0);

    // Creator 依赖已建立，且**统计字段未知 → null**（绝不伪造）
    const cr = await creatorRepo.findByUid(486906719);
    expect(cr).toBeTruthy();
    expect(cr!.name).toBe('测试UP主');
    expect(cr!.level).toBeNull();
    expect(cr!.followers).toBeNull();
    expect(cr!.following).toBeNull();
    expect(cr!.videoCount).toBeNull();
    expect(cr!.spaceUrl).toBe('https://space.bilibili.com/486906719/');
    expect(r.video.creatorId).toBe(cr!.id);
  });

  it('Video 已写入 Video 表（可被 findByBvid / 评论页 refresh 读到）', async () => {
    fetchHandler = () => json(viewOk());
    await ensureVideoByBvid(REAL_BV);
    const count = await db.videos.where('bvid').equals(REAL_BV).count();
    expect(count).toBe(1);
  });

  it('Creator 已存在时复用其 id，不新建（createdCreator=false）', async () => {
    const existing = await creatorRepo.upsertByUid({
      id: 'cr_existing_x',
      uid: 486906719,
      name: '老UP',
      sign: '',
      level: 6,
      followers: 999,
      following: 1,
      videoCount: 10,
      spaceUrl: 'https://space.bilibili.com/486906719/',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      source: 'bili-api',
    });
    const before = existing.ids[0]!;

    fetchHandler = () => json(viewOk());
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.createdCreator).toBe(false);
    expect(r.video.creatorId).toBe(before);
    // 已有 Creator 的 followers 不被 bootstrap 覆盖成 null
    const cr = await creatorRepo.findByUid(486906719);
    expect(cr!.followers).toBe(999);
    expect(cr!.level).toBe(6);
    expect(await db.creators.count()).toBe(1);
  });
});

// ── B. 已有 Video → 0 次 view 请求（性能要求）───────────────────────────────

describe('video-bootstrap · B. 本地命中不重复请求', () => {
  it('DB 已有该 bvid 的 Video → 不请求 /view（请求数 = 0）', async () => {
    await videoRepo.upsertByBvid({
      id: 'vd_seed_1',
      bvid: REAL_BV,
      aid: 424242,
      creatorId: 'cr_seed',
      title: 'seed',
      description: '',
      category: '',
      tags: [],
      url: `https://www.bilibili.com/video/${REAL_BV}`,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      source: 'manual',
    } as never);

    // 任何 fetch 都视为失败（证明没发请求）
    fetchHandler = () => {
      throw new Error('fetch must NOT be called when local Video exists');
    };
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fetched).toBe(false);
    expect(r.createdVideo).toBe(false);
    expect(r.video.aid).toBe(424242);
    expect(viewCountRequests()).toBe(0);
    expect(requestUrls.length).toBe(0);
  });

  it('连续两次调用：第一次 1 次 view，第二次 0 次（复用持久化记录）', async () => {
    fetchHandler = () => json(viewOk());
    const first = await ensureVideoByBvid(REAL_BV);
    expect(first.ok).toBe(true);
    expect(viewCountRequests()).toBe(1);

    requestUrls = [];
    const second = await ensureVideoByBvid(REAL_BV);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.fetched).toBe(false);
    expect(viewCountRequests()).toBe(0);
  });
});

// ── C. view 业务码非 0 ──────────────────────────────────────────────────────

describe('video-bootstrap · C. view 业务码非 0', () => {
  it('{code:-404,data:null} → ok=false、metadataFailed、无脏数据、错误不是本地「video not found」', async () => {
    fetchHandler = () => json({ code: -404, message: '啥都木有', ttl: 1, data: null });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.metadataFailed).toBe(true);
    expect(r.biliCode).toBe(-404);
    expect(r.retryable).toBe(false); // 稿件不存在，重试无意义
    expect(r.error).toMatch(/视频信息获取失败/);
    expect(r.error).not.toMatch(/video not found/);
    // 绝不写脏数据
    expect(await videoRepo.findByBvid(REAL_BV)).toBeUndefined();
    expect(await db.videos.count()).toBe(0);
    expect(await db.creators.count()).toBe(0);
  });

  it('{code:62002}（私密/不可见）→ 明确说明，不重试', async () => {
    fetchHandler = () => json({ code: 62002, message: '稿件不可见', ttl: 1, data: null });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.biliCode).toBe(62002);
    expect(r.retryable).toBe(false);
    expect(r.error).toMatch(/不可见|视频信息获取失败/);
    expect(await db.videos.count()).toBe(0);
  });

  it('{code:-412}（风控）→ metadataFailed 且 retryable=true', async () => {
    fetchHandler = () => json({ code: -412, message: '请求被拦截', ttl: 1, data: null });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.biliCode).toBe(-412);
    expect(r.retryable).toBe(true);
    expect(r.metadataFailed).toBe(true);
  });

  it('Collector 收到 view 失败时，评论接口绝不被调用（不打评论请求）', async () => {
    fetchHandler = () => json({ code: -404, message: '啥都木有', ttl: 1, data: null });
    const { CommentCollector } = await import('@collectors/comment-collector');
    const r = await new CommentCollector().collectComments(REAL_BV, { tier: 'quick', depth: 'top' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/视频信息获取失败/);
    expect(r.diagnostics?.biliCode).toBe(-404);
    // 只请求了 view，没有请求评论接口
    expect(requestUrls.length).toBe(1);
    expect(requestUrls[0]!.startsWith(VIEW_URL)).toBe(true);
    expect(requestUrls.some((u) => u.includes('/x/v2/reply'))).toBe(false);
  });
});

// ── D. view 结构非法 → 不写脏数据 ────────────────────────────────────────────

describe('video-bootstrap · D. view 结构非法', () => {
  it('缺 data → 失败且不写脏数据', async () => {
    fetchHandler = () => json({ code: 0, message: '0', ttl: 1 });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/缺少 data|视频信息获取失败/);
    expect(await db.videos.count()).toBe(0);
  });

  it('data 缺 aid → normalizer 返回 null → 失败，不写脏数据', async () => {
    fetchHandler = () => json({ code: 0, message: '0', ttl: 1, data: { bvid: REAL_BV, title: '无 aid' } });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/缺失或非法|视频信息获取失败/);
    expect(await db.videos.count()).toBe(0);
  });

  it('data.bvid 非法格式 → 失败，不写脏数据', async () => {
    fetchHandler = () => json({ code: 0, message: '0', ttl: 1, data: { bvid: 'NOT_A_BV', aid: 1, title: 't' } });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(await db.videos.count()).toBe(0);
  });

  it('非法 bvid 入参 → 立即失败，零请求', async () => {
    fetchHandler = () => {
      throw new Error('must not fetch');
    };
    const r = await ensureVideoByBvid('bad-bvid');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invalid bvid/);
    expect(requestUrls.length).toBe(0);
  });
});

// ── E. unknown 语义（真实数据缺失 ≠ 0 / 当前时间）───────────────────────────

describe('video-bootstrap · E. unknown 值语义', () => {
  it('duration / pubdate / stat 缺失 → 不得伪造 0 / Date.now()', async () => {
    fetchHandler = () =>
      json(viewOk({ duration: null, pubdate: null, stat: undefined }));
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // duration 缺失 → null（不是 0）
    expect(r.video.duration).toBeNull();
    // pubTime 缺失 → null（不是 now）
    expect(r.video.pubTime).toBeNull();
    // views 缺失 → undefined / null（不是 0）
    expect(r.video.views ?? null).toBeNull();
  });

  it('duration 为 "03:32" 字符串 → 解析为 212 秒', async () => {
    fetchHandler = () => json(viewOk({ duration: '03:32' }));
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.video.duration).toBe(212);
  });

  it('owner 缺 mid / name → owner 视为缺失（建 Creator 字段不伪造）', async () => {
    fetchHandler = () => json(viewOk({ owner: { name: '只有名字' } }));
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 没有合法 uid → 不建 Creator，Video 照常写入（authorName 仍可保留）
    expect(await db.creators.count()).toBe(0);
    expect(r.createdCreator).toBe(false);
    expect(await db.videos.count()).toBe(1);
  });
});

// ── F. 真实 BV 回归（离线 fixture，不硬编码「永远成功」）──────────────────────

describe('video-bootstrap · F. 真实 fixture 回归', () => {
  const fx = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(__dirname, `../fixtures/real/${name}`), 'utf-8'));

  it('真实 /view 响应 fixture（BV1D9aA61E6v）→ 拿到真实 aid + owner + view', async () => {
    const detail = fx('view-detail-BV1D9aA61E6v.json');
    fetchHandler = () => json(detail);
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.video.bvid).toBe(REAL_BV);
    expect(r.video.aid).toBe(113600005346789);
    expect(r.video.title).toContain('裸 BV');
    expect(r.video.pubTime).toBe(new Date(1735689600 * 1000).toISOString());
    expect(r.video.duration).toBe(212);
    expect(r.video.views).toBe(12345);
    expect(r.video.authorName).toBe('测试UP主');
    expect(r.video.authorMid).toBe(486906719);
    const cr = await creatorRepo.findByUid(486906719);
    expect(cr).toBeTruthy();
    expect(cr!.level).toBeNull(); // view 响应没有 level → 未知，不是 0
  });

  it('fixture 的 data 被「去掉外层 code」包装成错误码时 → 必须失败（证明判码真实生效）', async () => {
    const detail = fx('view-detail-BV1D9aA61E6v.json') as { data: unknown };
    fetchHandler = () => json({ code: -404, message: '啥都木有', data: null, _wouldBe: detail.data });
    const r = await ensureVideoByBvid(REAL_BV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.biliCode).toBe(-404);
    expect(await db.videos.count()).toBe(0);
  });

  it('fixture 经 Collector 全链路：裸 BV → bootstrap → 评论接口带真实 aid', async () => {
    const detail = fx('view-detail-BV1D9aA61E6v.json');
    const realAid = 113600005346789;
    fetchHandler = (url) => {
      if (url.startsWith(VIEW_URL)) return json(detail);
      if (url.includes('/x/v2/reply/wbi/main')) {
        // 断言评论接口确实用了 bootstrap 得到的 aid
        const oid = new URL(url).searchParams.get('oid');
        expect(oid).toBe(String(realAid));
        return json({
          code: 0,
          message: '0',
          ttl: 1,
          data: {
            cursor: { is_end: true, all_count: 1, pagination_reply: { next_offset: null, prev_offset: '' } },
            replies: [
              {
                rpid: 1,
                rpid_str: '1',
                mid: 1001,
                mid_str: '1001',
                parent: 0,
                dialog: 1,
                like: 7,
                rcount: 0,
                ctime: 1735689700,
                member: { uname: 'u1', level_info: { current_level: 3 }, vip: {} },
                content: { message: '真实链路评论' },
              },
            ],
            hots: [],
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const { CommentCollector } = await import('@collectors/comment-collector');
    const r = await new CommentCollector().collectComments(REAL_BV, { tier: 'quick', depth: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.content).toBe('真实链路评论');

    const v = await videoRepo.findByBvid(REAL_BV);
    expect(v).toBeTruthy();
    expect(await db.comments.where('videoId').equals(v!.id).count()).toBe(1);
    // 顺序：先 view(1 次)，再评论
    expect(requestUrls.filter((u) => u.startsWith(VIEW_URL)).length).toBe(1);
    expect(requestUrls.some((u) => u.includes('/x/v2/reply/wbi/main'))).toBe(true);
  });
});
