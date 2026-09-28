/**
 * HotTopic normalizer.
 * 来源：
 *   - api.bilibili.com/x/web-interface/ranking/v2  热门榜
 *   - api.bilibili.com/x/web-interface/search/square  热搜
 */

import { z } from 'zod';
import { hotTopicSchema, type HotTopic } from '@models/idea';
import { md5 } from '@utils/md5';
import { nowIso } from '@utils/time';

/**
 * 业务键 id：source + title 决定唯一性。
 * V0.1.2（P1-9）：此前每次刷新都用 newId('ht')，配合 bulkPut 会不断堆积重复行，
 * 榜单「刷新一次多一份」完全不可用。改成业务键后写入是「快照语义」：
 * 同一条热榜重复采集只更新 rank / timestamp，行数保持恒定。
 */
export function hotTopicBusinessId(source: string, title: string): string {
  return `ht_${md5(`${source}|${title}`).slice(0, 16)}`;
}

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
    const title = v.title || `untitled_${i}`;
    const cand = {
      id: hotTopicBusinessId(source, title),
      title,
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
    const title = v.show_name || v.keyword;
    const cand = {
      id: hotTopicBusinessId('bili-search', title),
      title,
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