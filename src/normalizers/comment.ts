/**
 * Comment normalizer（V0.2 · P0-A/P0-B/P0-C）。
 *
 * 真实接口：
 *  - 一级评论：`/x/v2/reply/wbi/main`（游标分页，mode=2 时间 / mode=3 热度）
 *    - 响应：data.replies[]、data.cursor.pagination_reply.next_offset、data.cursor.is_end、data.cursor.all_count
 *  - 二级回复：`/x/v2/reply/reply?type=1&oid={aid}&root={rpid}&pn=&ps=`
 *    - 响应：data.replies[]，每条 parent = root rpid、dialog = root rpid
 *
 * 字段映射严格按真实响应，不臆造。缺失字段 → 默认 0 / '' / null，UI 显示 –，绝不伪装成 0 表示「已采集到 0」。
 */

import { z } from 'zod';
import { commentSchema, type Comment } from '@models/comment';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';

const num = (v: unknown, d = 0): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  return d;
};

/** 单条回复原始结构（V0.2 真实接口；passthrough 保留未知字段便于调试） */
const rawReplySchema = z
  .object({
    rpid: z.union([z.string(), z.number()]).transform((v) => num(v)),
    rpid_str: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    mid: z.union([z.string(), z.number()]).transform((v) => num(v)),
    mid_str: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    parent: z.union([z.string(), z.number()]).transform((v) => num(v)).default(0),
    dialog: z.union([z.string(), z.number()]).transform((v) => num(v)).optional(),
    like: z.union([z.string(), z.number()]).transform((v) => num(v, 0)).default(0),
    rcount: z.union([z.string(), z.number()]).transform((v) => num(v, 0)).default(0),
    ctime: z.union([z.string(), z.number()]).transform((v) => num(v)).default(0),
    member: z
      .object({
        uname: z.string().default(''),
        sex: z.string().optional(),
        level_info: z.object({ current_level: z.number().int().min(0).max(7).default(0) }).default({}),
        vip: z.object({ vipStatus: z.number().int().optional() }).default({}),
        location: z.string().optional(),
      })
      .default({}),
    content: z
      .object({
        message: z.string().default(''),
        members: z.array(z.unknown()).optional(),
      })
      .default({ message: '' }),
  })
  .passthrough();

export interface ParseReplyCtx {
  videoId: string;
  replyLevel: 1 | 2 | 3;
  /** 根评论 rpid（一级=自身 rpid；二级=parent） */
  rootRpid: number;
  /** 父评论 rpid（一级=0；二级=parent） */
  parentRpid: number;
  source?: Comment['source'];
}

/** 把一条原始回复对象解析为 Comment（失败返回 null） */
export function parseReply(raw: unknown, ctx: ParseReplyCtx): Comment | null {
  const item = rawReplySchema.safeParse(raw);
  if (!item.success) return null;
  const c = item.data;
  const now = nowIso();
  const rpidStr = c.rpid_str ?? String(c.rpid);
  const midStr = c.mid_str ?? String(c.mid);
  const dialog = c.dialog ?? c.rpid;
  const cand = {
    id: newId('cm'),
    videoId: ctx.videoId,
    rpid: c.rpid,
    rpidStr,
    mid: c.mid,
    midStr,
    rootRpid: ctx.replyLevel === 1 ? c.rpid : ctx.rootRpid,
    parentRpid: ctx.replyLevel === 1 ? 0 : ctx.parentRpid,
    dialog,
    replyLevel: ctx.replyLevel,
    like: c.like,
    replyCount: c.rcount,
    ctime: c.ctime,
    uname: c.member.uname.slice(0, 64),
    content: c.content.message.slice(0, 8000),
    level: c.member.level_info.current_level,
    sex: c.member.sex,
    vipStatus: c.member.vip.vipStatus,
    location: c.member.location,
    contentRaw: c.content.members ? { message: c.content.message, members: c.content.members } : undefined,
    source: ctx.source ?? 'wbi-main',
    createdAt: now,
    updatedAt: now,
  };
  const final = commentSchema.safeParse(cand);
  return final.success ? final.data : null;
}

const replyPageSchema = z
  .object({
    code: z.number().int().default(0),
    message: z.string().default(''),
    data: z
      .object({
        cursor: z
          .object({
            // 真实接口在「没有下一页」时返回 next_offset: null，须允许 null
            pagination_reply: z
              .object({ next_offset: z.union([z.string(), z.number()]).nullable().optional() })
              .default({}),
            is_end: z.boolean().optional(),
            all_count: z.union([z.string(), z.number()]).transform((v) => num(v, 0)).optional(),
            prev: z.union([z.string(), z.number()]).nullable().optional(),
          })
          .default({}),
        replies: z.array(z.unknown()).default([]),
        hots: z.array(z.unknown()).optional(),
      })
      .default({ cursor: {}, replies: [], hots: undefined }),
  })
  .passthrough();

export interface CommentPageResult {
  comments: Comment[];
  /** 声明的总评论数（B 站 cursor.all_count，可能不可靠/被风控截断） */
  total: number;
  hasMore: boolean;
  /** 下一页游标；为空且 is_end=true 表示结束 */
  nextOffset: string | null;
  code: number;
  message: string;
  /** 解析失败（非对象 / code 非 0）时标记，调用方据此判断 environment_limited */
  ok: boolean;
}

export interface NormalizePageOpts {
  videoId: string;
  raw?: unknown;
  includeHots?: boolean;
}

/** 解析一级评论页（wbi/main 响应） */
export function normalizeCommentPage(opts: NormalizePageOpts): CommentPageResult {
  const rawObj = (opts.raw ?? {}) as { code?: number; message?: string };
  const parsed = replyPageSchema.safeParse(opts.raw ?? {});
  if (!parsed.success) {
    // 解析失败（响应结构异常 / data 缺失）：保留真实 code / message，便于上层判断环境受限
    return {
      comments: [],
      total: 0,
      hasMore: false,
      nextOffset: null,
      code: typeof rawObj.code === 'number' ? rawObj.code : -1,
      message: rawObj.message ?? 'invalid page',
      ok: false,
    };
  }
  const data = parsed.data.data;
  if (parsed.data.code !== 0) {
    return {
      comments: [],
      total: num(data.cursor.all_count, 0),
      hasMore: false,
      nextOffset: null,
      code: parsed.data.code,
      message: parsed.data.message,
      ok: false,
    };
  }
  const out: Comment[] = [];
  const seen = new Set<string>();
  const consume = (raw: unknown) => {
    const c = parseReply(raw, { videoId: opts.videoId, replyLevel: 1, rootRpid: 0, parentRpid: 0, source: 'wbi-main' });
    if (!c) return;
    const key = `${c.rpidStr}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const r of data.replies) consume(r);
  if (opts.includeHots && data.hots) for (const r of data.hots) consume(r);

  const nextOffset =
    data.cursor.pagination_reply.next_offset != null
      ? String(data.cursor.pagination_reply.next_offset)
      : null;
  const isEnd = data.cursor.is_end ?? false;
  const total = num(data.cursor.all_count, 0);
  // 有 next_offset 且未声明结束 → 还有更多；否则按「已取数 < 声明总数」兜底
  const hasMore = !isEnd && (nextOffset !== null || out.length < total);
  return {
    comments: out,
    total,
    hasMore,
    nextOffset,
    code: 0,
    message: 'ok',
    ok: true,
  };
}

/** 解析二级回复页（reply 响应） */
export function normalizeSubReplies(opts: {
  videoId: string;
  rootRpid: number;
  raw?: unknown;
}): CommentPageResult {
  const rawObj = (opts.raw ?? {}) as { code?: number; message?: string };
  const parsed = replyPageSchema.safeParse(opts.raw ?? {});
  if (!parsed.success) {
    return {
      comments: [],
      total: 0,
      hasMore: false,
      nextOffset: null,
      code: typeof rawObj.code === 'number' ? rawObj.code : -1,
      message: rawObj.message ?? 'invalid page',
      ok: false,
    };
  }
  const data = parsed.data.data;
  if (parsed.data.code !== 0) {
    return {
      comments: [],
      total: 0,
      hasMore: false,
      nextOffset: null,
      code: parsed.data.code,
      message: parsed.data.message,
      ok: false,
    };
  }
  const out: Comment[] = [];
  for (const r of data.replies) {
    const c = parseReply(r, {
      videoId: opts.videoId,
      replyLevel: 2,
      rootRpid: opts.rootRpid,
      parentRpid: opts.rootRpid,
      source: 'reply',
    });
    if (c) out.push(c);
  }
  const nextOffset =
    data.cursor.pagination_reply.next_offset != null
      ? String(data.cursor.pagination_reply.next_offset)
      : null;
  const isEnd = data.cursor.is_end ?? false;
  const hasMore = !isEnd && nextOffset !== null;
  return { comments: out, total: 0, hasMore, nextOffset, code: 0, message: 'ok', ok: true };
}
