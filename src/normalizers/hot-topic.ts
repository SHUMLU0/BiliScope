/**
 * HotTopic normalizer.
 * 来源：
 *   - api.bilibili.com/x/web-interface/ranking/v2  热门榜
 *   - api.bilibili.com/x/web-interface/search/square  热搜
 */

import { z } from 'zod';
import { hotTopicSchema, type HotTopic } from '@models/idea';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';

const hotRespSchema = z
  .object({
    code: z.number().int().default(0),
    message: z.string().default(''),
    data: z
      .object({
        list: z
          .array(
            z
              .object({
                aid: z.number().int().optional(),
                bvid: z.string().optional(),
                title: z.string().default(''),
                tname: z.string().default(''),
                pic: z.string().default(''),
                short_link: z.string().optional(),
                link: z.string().optional(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .default({ list: [] }),
  })
  .passthrough();

export function normalizeHotList(raw: unknown, source: HotTopic['source'] = 'bili-hot'): HotTopic[] {
  const parsed = hotRespSchema.safeParse(raw);
  if (!parsed.success || parsed.data.code !== 0) return [];
  const list = parsed.data.data.list;
  const now = nowIso();
  const out: HotTopic[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v) continue;
    const cand = {
      id: newId('ht'),
      title: v.title || `untitled_${i}`,
      source,
      url: v.short_link || v.link || (v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : undefined),
      rank: i + 1,
      timestamp: now,
      category: v.tname,
      relatedTags: [],
    };
    const final = hotTopicSchema.safeParse(cand);
    if (final.success) out.push(final.data);
  }
  return out;
}

const searchSquareSchema = z
  .object({
    code: z.number().int().default(0),
    data: z
      .object({
        trending: z
          .object({
            list: z
              .array(
                z
                  .object({
                    keyword: z.string().default(''),
                    show_name: z.string().default(''),
                    icon: z.string().optional(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .default({ list: [] }),
      })
      .default({ trending: { list: [] } }),
  })
  .passthrough();

export function normalizeHotSearch(raw: unknown): HotTopic[] {
  const parsed = searchSquareSchema.safeParse(raw);
  if (!parsed.success || parsed.data.code !== 0) return [];
  const list = parsed.data.data.trending.list;
  const now = nowIso();
  const out: HotTopic[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v || !v.keyword) continue;
    const cand = {
      id: newId('ht'),
      title: v.show_name || v.keyword,
      source: 'bili-search' as const,
      url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(v.keyword)}`,
      rank: i + 1,
      timestamp: now,
      category: '',
      relatedTags: [v.keyword],
    };
    const final = hotTopicSchema.safeParse(cand);
    if (final.success) out.push(final.data);
  }
  return out;
}