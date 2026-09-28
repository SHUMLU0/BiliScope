/**
 * Comment normalizer.
 * 公开接口：reply API；v2 协议需要登录态，本项目只走 v1 公开评论。
 */

import { z } from 'zod';
import { commentSchema, type Comment } from '@models/comment';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';

const rawReplySchema = z
  .object({
    rpid: z.union([z.string(), z.number()]).transform((v) => Number(v)),
    mid: z.union([z.string(), z.number()]).transform((v) => Number(v)),
    uname: z.string().default(''),
    content: z
      .object({
        message: z.string().default(''),
      })
      .default({ message: '' }),
    like: z.union([z.string(), z.number()]).transform((v) => Number(v ?? 0)).default(0),
    count: z.union([z.string(), z.number()]).transform((v) => Number(v ?? 0)).default(0),
    ctime: z.union([z.string(), z.number()]).transform((v) => Number(v)).default(0),
    member: z
      .object({
        level_info: z
          .object({ current_level: z.number().int().min(0).max(7).default(0) })
          .default({ current_level: 0 }),
      })
      .default({ level_info: { current_level: 0 } }),
    replies: z.array(z.unknown()).optional(),
  })
  .passthrough();

const replyPageSchema = z
  .object({
    code: z.number().int().default(0),
    message: z.string().default(''),
    data: z
      .object({
        page: z.object({ count: z.number().int().nonnegative().default(0) }).default({ count: 0 }),
        replies: z.array(z.unknown()).default([]),
        hots: z.array(z.unknown()).optional(),
      })
      .default({ page: { count: 0 }, replies: [] }),
  })
  .passthrough();

interface NormalizeOpts {
  videoId: string;
  parentId?: number;
  maxItems?: number;
  includeHots?: boolean;
  raw?: unknown;
}

export interface CommentPageResult {
  comments: Comment[];
  total: number;
  hasMore: boolean;
}

export function normalizeCommentPage(opts: NormalizeOpts): CommentPageResult {
  const parsed = replyPageSchema.safeParse(opts.raw);
  if (!parsed.success) return { comments: [], total: 0, hasMore: false };
  if (parsed.data.code !== 0) return { comments: [], total: 0, hasMore: false };
  const data = parsed.data.data;
  const now = nowIso();
  const out: Comment[] = [];
  const parentId = opts.parentId ?? 0;
  const maxItems = opts.maxItems ?? 1000;
  const seenRpid = new Set<number>();

  const consume = (raw: unknown) => {
    const item = rawReplySchema.safeParse(raw);
    if (!item.success) return;
    const c = item.data;
    if (seenRpid.has(c.rpid)) return;
    seenRpid.add(c.rpid);
    const midHash = c.mid.toString(16).padStart(32, '0').slice(-32);
    const cand = {
      id: newId('cm'),
      videoId: opts.videoId,
      parentId,
      rpid: c.rpid,
      memberId: midHash,
      uname: c.uname.slice(0, 64),
      content: c.content.message.slice(0, 5000),
      like: c.like,
      replyCount: c.count,
      ctime: c.ctime,
      level: c.member.level_info.current_level,
      rawData: undefined,
      createdAt: now,
    };
    const final = commentSchema.safeParse(cand);
    if (final.success) out.push(final.data);
  };

  for (const r of data.replies) {
    if (out.length >= maxItems) break;
    consume(r);
  }
  if (opts.includeHots && data.hots) {
    for (const r of data.hots) {
      if (out.length >= maxItems) break;
      consume(r);
    }
  }

  const total = data.page.count;
  return { comments: out, total, hasMore: out.length < total };
}