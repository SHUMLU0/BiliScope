import { describe, expect, it } from 'vitest';
import { normalizeCommentPage, normalizeSubReplies } from '@normalizers/comment';

function rawReply(i: number, over: Record<string, unknown> = {}) {
  return {
    rpid: i,
    rpid_str: String(i),
    mid: 1000 + i,
    mid_str: String(1000 + i),
    parent: 0,
    dialog: i,
    like: 1,
    rcount: 0,
    ctime: 1700000000 + i,
    member: { uname: `u${i}`, level_info: { current_level: 1 }, vip: {}, location: undefined },
    content: { message: `m${i}` },
    ...over,
  };
}

function mainRaw(opts: { replies: unknown[]; all_count: number; is_end: boolean; next_offset: string | null }) {
  return {
    code: 0,
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

describe('normalizeCommentPage (V0.2 cursor)', () => {
  it('happy path parses replies + cursor', () => {
    const raw = mainRaw({ replies: [rawReply(1), rawReply(2)], all_count: 100, is_end: false, next_offset: 'abc' });
    const r = normalizeCommentPage({ videoId: 'v1', raw });
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.comments).toHaveLength(2);
    expect(r.comments[0]!.uname).toBe('u1');
    expect(r.total).toBe(100);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe('abc');
  });

  it('empty + not ok on code != 0', () => {
    const r = normalizeCommentPage({ videoId: 'v', raw: { code: -412, data: null } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(-412);
    expect(r.comments).toEqual([]);
  });

  it('is_end -> hasMore false and nextOffset null', () => {
    const r = normalizeCommentPage({
      videoId: 'v',
      raw: mainRaw({ replies: [rawReply(1)], all_count: 1, is_end: true, next_offset: null }),
    });
    expect(r.hasMore).toBe(false);
    expect(r.nextOffset).toBeNull();
  });

  it('dedupes by rpid_str', () => {
    const r = normalizeCommentPage({
      videoId: 'v',
      raw: mainRaw({
        replies: [rawReply(1), { ...rawReply(1), content: { message: 'dup' } }],
        all_count: 5,
        is_end: true,
        next_offset: null,
      }),
    });
    expect(r.comments).toHaveLength(1);
  });

  it('maps replyCount from rcount and string ids', () => {
    const r = normalizeCommentPage({
      videoId: 'v',
      raw: mainRaw({ replies: [rawReply(1, { rcount: 7 })], all_count: 1, is_end: true, next_offset: null }),
    });
    expect(r.comments[0]!.replyCount).toBe(7);
    expect(r.comments[0]!.midStr).toBe('1001');
    expect(r.comments[0]!.rpidStr).toBe('1');
    expect(r.comments[0]!.replyLevel).toBe(1);
  });

  it('normalizeSubReplies sets replyLevel=2 and rootRpid', () => {
    const raw = {
      code: 0,
      data: {
        cursor: { all_count: 0, is_end: true, pagination_reply: { next_offset: null } },
        replies: [rawReply(5, { parent: 99, dialog: 99 })],
      },
    };
    const r = normalizeSubReplies({ videoId: 'v', rootRpid: 99, raw });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.replyLevel).toBe(2);
    expect(r.comments[0]!.rootRpid).toBe(99);
    expect(r.comments[0]!.parentRpid).toBe(99);
  });
});
