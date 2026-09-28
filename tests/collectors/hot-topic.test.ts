import { describe, expect, it, vi } from 'vitest';
import { HotTopicCollector } from '@collectors/hot-topic-collector';
import { db } from '@db/database';

describe('HotTopicCollector', () => {
  it('happy path: bili-hot', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('ranking')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { list: [{ title: 't1' }, { title: 't2' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('square')) {
        return new Response(JSON.stringify({ code: 0, data: { trending: { list: [] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('unmocked');
    }) as unknown as typeof fetch;

    const c = new HotTopicCollector();
    const r = await c.collect({ targetId: '', context: { mode: 'top' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(2);
    const persisted = await db.hotTopics.count();
    expect(persisted).toBeGreaterThanOrEqual(2);
  });

  it('mode=search', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('square')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { trending: { list: [{ keyword: 'AI', show_name: 'AI 工具' }] } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unmocked');
    }) as unknown as typeof fetch;
    const c = new HotTopicCollector();
    const r = await c.collect({ targetId: '', context: { mode: 'search' } });
    expect(r.ok).toBe(true);
  });
});