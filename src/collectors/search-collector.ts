/**
 * SearchCollector
 * 用于全站雷达 / 灵感：基于公开搜索接口。
 *
 * 入口：collect({ targetId: keyword, context: { page } })
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';
import { normalizeVideoList } from '@normalizers/video';
import type { Collector, CollectorInput, CollectorResult } from './types';
import type { Video } from '@models/video';

interface BiliSearchResp {
  code?: number;
  data?: {
    result?: { video?: unknown[] };
  };
}

export class SearchCollector implements Collector<Video> {
  readonly name = 'search';

  async collect(input: CollectorInput): Promise<CollectorResult<Video>> {
    const keyword = input.targetId.trim();
    if (!keyword) {
      return { ok: false, error: 'empty keyword', retryable: false };
    }
    const page = Number(input.context?.page ?? 1);
    try {
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
        keyword,
      )}&page=${page}&page_size=20&order=pubdate&platform=web&web_location=40020`;
      const res = await httpGet<BiliSearchResp>(url, { signal: input.signal });
      if (res.code !== 0) {
        return { ok: false, error: `search code=${res.code}`, retryable: false };
      }
      const list = normalizeVideoList(res.data?.result?.video ?? [], {
        creatorId: 'search',
        source: 'bili-web',
      });
      logger.info(`SearchCollector keyword="${keyword}" page=${page} got ${list.length}`);
      return { ok: true, data: list, fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}