/**
 * HotTopicCollector
 * 来源：
 *   - 全站热门：api.bilibili.com/x/web-interface/ranking/v2
 *   - 热搜词：api.bilibili.com/x/web-interface/search/square
 */

import { httpGet } from '@utils/http';
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
        });
        const list = normalizeHotSearch(res);
        if (list.length) await hotTopicRepo.bulkAdd(list);
        logger.info(`HotTopicCollector mode=search collected ${list.length}`);
        return { ok: true, data: list, fetched: true };
      }
      const res = await httpGet<unknown>('https://api.bilibili.com/x/web-interface/ranking/v2', {
        signal: input.signal,
      });
      const list = normalizeHotList(res, 'bili-hot');
      if (list.length) await hotTopicRepo.bulkAdd(list);
      logger.info(`HotTopicCollector mode=top collected ${list.length}`);
      return { ok: true, data: list, fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}