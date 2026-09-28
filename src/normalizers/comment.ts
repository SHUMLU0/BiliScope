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

/**
 * V0.2.1（P1-10）：区分「真实 0 / 字段缺失 / 接口失败」。
 *  - 真实数字（含 0）→ 原样返回
 *  - 数字字符串        → 解析；解析不出 → `fallback`
 *  - 字段缺失 / null / undefined / 空串 → `fallback`
 * 调用方对「可为空的互动字段」传 `fallback = null`（不伪装成 0），
 * 对「模型要求 nonnegative」的字段传 0（如 ctime 缺失时由 schema 兜底）。
 */
const num = (v: unknown, fallback: number | null = null): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

/** 断言为数字（用于 schema 要求非空的字段）；缺失时返回 0 由上层语义决定 */
const numOr0 = (v: unknown): number => num(v, 0) ?? 0;

/** 单条回复原始结构（V0.2 真实接口；passthrough 保留未知字段便于调试） */
const rawReplySchema = z
  .object({
    rpid: z.union([z.string(), z.number()]).transform((v) => numOr0(v)),
    rpid_str: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    mid: z.union([z.string(), z.number()]).transform((v) => numOr0(v)),
    mid_str: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    parent: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).default(0),
    dialog: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).optional(),
    like: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).default(0),
    rcount: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).default(0),
    ctime: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).default(0),
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
    /**
     * V0.2.1（P1-10）：IP 属地在 `reply_control.location`（形如 "IP属地：北京"），
     * `member.location` 在新版响应里常常不存在。两者都尝试，缺失 → undefined（不写 "未知"）。
     */
    reply_control: z.object({ location: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/** 从 "IP属地：北京" 提取 "北京"；已是纯地名则原样返回 */
function extractLocation(replyControl?: string, memberLoc?: string): string | undefined {
  const raw = replyControl ?? memberLoc;
  if (!raw) return undefined;
  const cleaned = raw.replace(/^IP属地[:：]\s*/, '').trim();
  return cleaned !== '' ? cleaned.slice(0, 64) : undefined;
}

export interface ParseReplyCtx {
  videoId: string;
  replyLevel: 1 | 2 | 3;
  /** 根评论 rpid（一级=自身 rpid；二级=parent） */
  rootRpid: number;
  /** 父评论 rpid（一级=0；二级=parent） */
  parentRpid: number;
  /** V0.2.1（P1-8）：根评论 rpid 字符串 canonical key（二级回复必传） */
  rootRpidStr?: string;
  /** V0.2.1（P1-8）：父评论 rpid 字符串 canonical key */
  parentRpidStr?: string;
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
  // V0.2.1（P1-8）：字符串关系键作为 canonical，数字字段仅兼容
  const rootRpidNum = ctx.replyLevel === 1 ? c.rpid : ctx.rootRpid;
  const parentRpidNum = ctx.replyLevel === 1 ? 0 : ctx.parentRpid;
  const cand = {
    id: newId('cm'),
    videoId: ctx.videoId,
    rpid: c.rpid,
    rpidStr,
    mid: c.mid,
    midStr,
    rootRpid: rootRpidNum,
    parentRpid: parentRpidNum,
    dialog,
    replyLevel: ctx.replyLevel,
    rootRpidStr: ctx.rootRpidStr ?? (ctx.replyLevel === 1 ? rpidStr : String(rootRpidNum)),
    parentRpidStr:
      ctx.parentRpidStr ?? (ctx.replyLevel === 1 ? '' : String(parentRpidNum)),
    dialogStr: String(dialog),
    like: c.like,
    replyCount: c.rcount,
    ctime: c.ctime,
    uname: c.member.uname.slice(0, 64),
    content: c.content.message.slice(0, 8000),
    level: c.member.level_info.current_level,
    sex: c.member.sex,
    vipStatus: c.member.vip.vipStatus,
    location: extractLocation(c.reply_control?.location, c.member.location),
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
              .object({
                next_offset: z.union([z.string(), z.number()]).nullable().optional(),
                prev_offset: z.union([z.string(), z.number()]).nullable().optional(),
              })
              .default({}),
            is_end: z.boolean().optional(),
            all_count: z.union([z.string(), z.number()]).transform((v) => numOr0(v)).optional(),
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
      total: numOr0(data.cursor.all_count),
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
  const total = numOr0(data.cursor.all_count);
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

/**
 * 解析二级回复页（reply 响应）。
 *
 * V0.2.1（P0-5）：二级接口是 **pn 页码分页**，不再读取
 * `cursor.pagination_reply.next_offset`（那属于一级接口）。
 * `hasMore` 交给 Collector 依据「本页条数 < ps」判定；这里只把真实页长
 * 通过 `total` 之外的 `rawCount` 暴露出来，避免用 cursor 误判。
 */
export function normalizeSubReplies(opts: {
  videoId: string;
  rootRpid: number;
  /** V0.2.1（P1-8）：root rpid 字符串版（优先用于关系键） */
  rootRpidStr?: string;
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
  const rootRpidStr = opts.rootRpidStr ?? String(opts.rootRpid);
  const out: Comment[] = [];
  for (const r of data.replies) {
    const c = parseReply(r, {
      videoId: opts.videoId,
      replyLevel: 2,
      rootRpid: opts.rootRpid,
      parentRpid: opts.rootRpid,
      rootRpidStr,
      parentRpidStr: rootRpidStr,
      source: 'reply',
    });
    if (c) out.push(c);
  }
  // 真实原始条数（可能含解析失败项）——Collector 用它与 ps 比较判断是否到底
  const rawCount = data.replies.length;
  return {
    comments: out,
    total: rawCount,
    hasMore: false, // 由 Collector 按 rawCount < ps 判定，不依赖 cursor
    nextOffset: null,
    code: 0,
    message: 'ok',
    ok: true,
  };
}
