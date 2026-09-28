import { describe, expect, it } from 'vitest';
import { detectFromUrl, bvidToAid } from '@content/detect';
import { vi } from 'vitest';

describe('detectFromUrl', () => {
  it('detects space.bilibili.com', () => {
    const r = detectFromUrl('https://space.bilibili.com/12345/');
    expect(r).toEqual({ type: 'creator', id: '12345', rawUrl: 'https://space.bilibili.com/12345/' });
  });

  it('detects video page', () => {
    const r = detectFromUrl('https://www.bilibili.com/video/BV1xxxxxxxxxx?p=1');
    expect(r?.type).toBe('video');
    expect(r?.id).toBe('BV1xxxxxxxxxx');
  });

  it('detects search page', () => {
    const r = detectFromUrl('https://search.bilibili.com/all?keyword=AI%20%E5%B7%A5%E5%85%B7');
    expect(r?.type).toBe('search');
    expect(r?.id).toBe('AI 工具');
  });

  it('returns null on irrelevant url', () => {
    expect(detectFromUrl('https://example.com')).toBeNull();
  });
});

describe('bvidToAid', () => {
  it('parses aid', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { aid: 999 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    expect(await bvidToAid('BV1xxxxxxxxxx')).toBe(999);
  });

  it('returns null on error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(await bvidToAid('BV1xxxxxxxxxx')).toBeNull();
  });
});