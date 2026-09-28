/**
 * CommentCollector
 * 入口：collect(bvid)  —— 分页拉评论，最多 1000 条 / 视频
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';
import { commentRepo, videoRepo } from '@repositories/index';
import type { Collector, CollectorInput, CollectorResult } from './types';
import type { Comment } from '@models/comment';
import { normalizeCommentPage } from '@normalizers/comment';

export class CommentCollector implements Collector<Comment> {
  readonly name = 'comment';

  async collect(input: CollectorInput): Promise<CollectorResult<Comment>> {
    const bvid = input.targetId;
    const video = await videoRepo.findByBvid(bvid);
    if (!video) {
      return { ok: false, error: `video not found for bvid=${bvid}`, retryable: false };
    }
    const aid = video.aid;

    try {
      const all: Comment[] = [];
      let pn = 1;
      const ps = 20;
      const maxItems = 1000;

      while (all.length < maxItems) {
        const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=${pn}&ps=${ps}&sort=2`;
        const res = await httpGet<unknown>(url, { signal: input.signal });
        const page = normalizeCommentPage({ videoId: video.id, raw: res, maxItems: maxItems - all.length });
        if (!page.comments.length) break;
        all.push(...page.comments);
        if (!page.hasMore) break;
        pn++;
      }

      const upserted = await commentRepo.bulkAdd(all);
      logger.info(`CommentCollector bvid=${bvid} added=${upserted.added} unchanged=${upserted.unchanged}`);
      // V0.1.2（P1-7）：data 是本次抓到的全部评论（含已存在），
      // 「新增几条」必须用 upserted.added，UI 不能再拿 data.length 冒充。
      return {
        ok: true,
        data: all,
        fetched: true,
        stats: { added: upserted.added, updated: upserted.updated, unchanged: upserted.unchanged },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}