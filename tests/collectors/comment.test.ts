import { describe, expect, it, vi } from 'vitest';
import { CommentCollector } from '@collectors/comment-collector';
import { db } from '@db/database';
import { videoRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { videoSchema } from '@models/video';

describe('CommentCollector', () => {
  it('requires video to be in DB', async () => {
    const c = new CommentCollector();
    const r = await c.collect({ targetId: 'BV1xxxxxxxxx' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/video not found/);
  });

  it('happy path: parses reply pages and stores', async () => {
    // pre-populate a video
    await db.videos.add(
      videoSchema.parse({
        id: newId('vd'),
        bvid: 'BV1xxxxxxxxx',
        aid: 999,
        creatorId: 'cr_test',
        title: 't',
        description: '',
        cover: undefined,
        pubTime: nowIso(),
        duration: 10,
        category: '',
        tags: [],
        url: 'https://www.bilibili.com/video/BV1xxxxxxxxxx',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'manual',
      }),
    );

    const replies = Array.from({ length: 25 }, (_, i) => ({
      rpid: i + 1,
      mid: 1000 + i,
      uname: `u${i}`,
      content: { message: `c${i}` },
      like: 0,
      count: 0,
      ctime: 1700000000,
      member: { level_info: { current_level: 0 } },
    }));
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { page: { count: 25 }, replies } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const c = new CommentCollector();
    const r = await c.collect({ targetId: 'BV1xxxxxxxxx' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(25);

    const v = await videoRepo.findByBvid('BV1xxxxxxxxx');
    expect(v).toBeTruthy();
    if (!v) return;
    const list = await db.comments.where('videoId').equals(v.id).count();
    expect(list).toBe(25);
  });
});