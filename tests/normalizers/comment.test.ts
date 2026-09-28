import { describe, expect, it } from 'vitest';
import { normalizeCommentPage } from '@normalizers/comment';

describe('normalizeCommentPage', () => {
  it('happy path', () => {
    const raw = {
      code: 0,
      data: {
        page: { count: 2 },
        replies: [
          {
            rpid: 1,
            mid: 100,
            uname: 'alice',
            content: { message: 'hi' },
            like: 3,
            count: 0,
            ctime: 1700000000,
            member: { level_info: { current_level: 2 } },
          },
        ],
      },
    };
    const r = normalizeCommentPage({ videoId: 'v1', raw });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.uname).toBe('alice');
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(true);
  });

  it('empty on code != 0', () => {
    const r = normalizeCommentPage({ videoId: 'v', raw: { code: -101 } });
    expect(r.comments).toEqual([]);
  });

  it('dedupes by rpid', () => {
    const raw = {
      code: 0,
      data: {
        page: { count: 5 },
        replies: [
          { rpid: 1, mid: 100, uname: 'a', content: { message: 'x' }, like: 0, count: 0, ctime: 1, member: { level_info: { current_level: 0 } } },
          { rpid: 1, mid: 100, uname: 'a', content: { message: 'dup' }, like: 0, count: 0, ctime: 1, member: { level_info: { current_level: 0 } } },
        ],
      },
    };
    const r = normalizeCommentPage({ videoId: 'v', raw });
    expect(r.comments).toHaveLength(1);
  });

  it('truncates to maxItems', () => {
    const replies = Array.from({ length: 10 }, (_, i) => ({
      rpid: i + 1,
      mid: i + 1,
      uname: `u${i}`,
      content: { message: 'm' },
      like: 0,
      count: 0,
      ctime: 1,
      member: { level_info: { current_level: 0 } },
    }));
    const raw = { code: 0, data: { page: { count: 100 }, replies } };
    const r = normalizeCommentPage({ videoId: 'v', raw, maxItems: 3 });
    expect(r.comments).toHaveLength(3);
  });

  it('hashes mid to 32 hex', () => {
    const raw = {
      code: 0,
      data: {
        page: { count: 1 },
        replies: [
          { rpid: 1, mid: 12345, uname: 'x', content: { message: 'm' }, like: 0, count: 0, ctime: 1, member: { level_info: { current_level: 0 } } },
        ],
      },
    };
    const r = normalizeCommentPage({ videoId: 'v', raw });
    expect(r.comments[0]!.memberId).toMatch(/^[a-f0-9]{32}$/);
  });
});