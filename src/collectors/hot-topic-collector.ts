/**
 * HotTopicCollector
 * 来源：
 *   - 全站热门：api.bilibili.com/x/web-interface/ranking/v2
 *   - 热搜词：api.bilibili.com/x/web-interface/search/square
 */

import { httpGet } from '@utils/http';
import { BILI_REFERRER } from '@utils/bili';
import { logger } from '@utils/logger';
import { normalizeHotList, normalizeHotSearch } from '@normalizers/hot-topic';
import { hotTopicRepo } from '@repositories/index';
import type { Collector, CollectorInput, CollectorResult } from './types';
import type { HotTopic } from '@models/idea';

export class HotTopicCollector implements Collector<HotTopic> {
  readonly name = 'hot-topic';

  async collect(input: CollectorInput): Promise<CollectorResult<HotTopic>> {
    const mode = (input.context?.mode as string) ?? 'top';
    try {
      if (mode === 'search') {
        const res = await httpGet<unknown>('https://api.bilibili.com/x/web-interface/search/square', {
          signal: input.signal,
          referrer: BILI_REFERRER.search,
        });
        const list = normalizeHotSearch(res);
        const upserted = list.length ? await hotTopicRepo.bulkAdd(list) : null;
        logger.info(`HotTopicCollector mode=search collected ${list.length}`);
        return { ok: true, data: list, fetched: true, stats: upserted ?? undefined };
      }
      const res = await httpGet<unknown>('https://api.bilibili.com/x/web-interface/ranking/v2', {
        signal: input.signal,
        referrer: BILI_REFERRER.www,
      });
      const list = normalizeHotList(res, 'bili-hot');
      const upserted = list.length ? await hotTopicRepo.bulkAdd(list) : null;
      logger.info(`HotTopicCollector mode=top collected ${list.length}`);
      return { ok: true, data: list, fetched: true, stats: upserted ?? undefined };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}