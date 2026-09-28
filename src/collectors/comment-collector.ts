/**
 * CommentCollector（V0.2 · P0-A/P0-B）。
 *
 * 入口：
 *  - collect(input)            按 input.context.commentOptions 配置采集
 *  - collectComments(bvid, opts) 直接以编程方式采集（测试 / 任务系统调用）
 *
 * 采集档位（tier）：quick=50 / standard=200 / deep=500 / max=1000
 * 排序（sort）：hot → mode=3，time → mode=2
 * 深度（depth）：top=仅一级；deep=展开前 30 个一级的二级回复；advanced=前 100 个
 *
 * 一级接口：/x/v2/reply/wbi/main（游标分页：pagination_reply.next_offset / cursor.is_end / cursor.all_count）
 * 二级接口：/x/v2/reply/reply?type=1&oid={aid}&root={rpid}&pn=&ps= （按 pn 翻页）
 *
 * 禁止写死 pn<=3 或只取第一页；数量由档位控制，不默认跑满 1000。
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';
import { commentRepo, videoRepo } from '@repositories/index';
import type { Collector, CollectorInput, CollectorResult, CollectorStats, CollectorDiagnostics } from './types';
import type { Comment } from '@models/comment';
import {
  COMMENT_TIER_LIMIT,
  type CommentTier,
  type CommentSort,
  type CommentDepth,
} from '@models/comment';
import { normalizeCommentPage, normalizeSubReplies } from '@normalizers/comment';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
import { BILI_REFERRER } from '@utils/bili';

export interface CommentCollectOptions {
  sort?: CommentSort;
  tier?: CommentTier;
  depth?: CommentDepth;
  /** 安全上限：最多翻多少页（防止失控循环），默认 100 */
  maxPages?: number;
}

const SUB_PS = 20;
const TOP_EXPAND_DEEP = 30;
const TOP_EXPAND_ADVANCED = 100;

export class CommentCollector implements Collector<Comment> {
  readonly name = 'comment';

  async collect(input: CollectorInput): Promise<CollectorResult<Comment>> {
    const opts = (input.context?.commentOptions as CommentCollectOptions | undefined) ?? {};
    return this.collectComments(input.targetId, opts, input.signal);
  }

  async collectComments(
    bvid: string,
    opts: CommentCollectOptions = {},
    signal?: AbortSignal,
  ): Promise<CollectorResult<Comment>> {
    const video = await videoRepo.findByBvid(bvid);
    if (!video) {
      return { ok: false, error: `video not found for bvid=${bvid}`, retryable: false };
    }
    const aid = video.aid;
    const sort = opts.sort ?? 'time';
    const mode = sort === 'hot' ? 3 : 2;
    const tierLimit = COMMENT_TIER_LIMIT[opts.tier ?? 'standard'];
    const depth = opts.depth ?? 'top';
    const maxPages = opts.maxPages ?? 100;

    const diag: CollectorDiagnostics = { pages: 0 };
    const all: Comment[] = [];
    let expectedTotal = 0;
    let biliCode: number | undefined;
    let nextOffset: string | null = '';
    let page = 0;

    try {
      while (all.length < tierLimit && page < maxPages) {
        page++;
        const query = await this.buildMainQuery(aid, mode, nextOffset);
        const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${query}`;
        const res = await httpGet<unknown>(url, { signal, referrer: BILI_REFERRER.video(bvid) });
        const parsed = normalizeCommentPage({ videoId: video.id, raw: res });
        biliCode = parsed.code;
        if (!parsed.ok) {
          // code != 0（风控 / 未登录 / 接口异常）→ 环境受限，必须明确告知，不可伪装成「采集完成」
          diag.environmentLimited = true;
          diag.biliCode = parsed.code;
          diag.message = parsed.message;
          break;
        }
        for (const c of parsed.comments) {
          if (all.length >= tierLimit) break;
          all.push(c);
        }
        if (parsed.total > expectedTotal) expectedTotal = parsed.total;
        diag.pages = page;
        if (!parsed.hasMore || parsed.nextOffset === null) break;
        nextOffset = parsed.nextOffset;
      }

      // 二级回复（深度模式）：对满足条件的一级评论展开，限制展开数量避免触发风控
      if (depth !== 'top' && all.length > 0) {
        const expandN = depth === 'advanced' ? TOP_EXPAND_ADVANCED : TOP_EXPAND_DEEP;
        const roots = all.filter((c) => c.replyLevel === 1 && c.replyCount >= 1).slice(0, expandN);
        for (const root of roots) {
          if (all.length >= tierLimit) break;
          await this.collectSubReplies(video.id, aid, root.rpid, all, tierLimit, bvid, signal);
        }
      }

      // P0-D：环境受限（风控 / 未登录 / 接口异常）且一条都没拿到 → 明确失败，绝不伪装「采集完成」。
      // 若已拿到部分数据后又被拦截，则仍返回 ok:true（确实采集到内容），由 diagnostics.environmentLimited 标记不完整。
      if (all.length === 0 && diag.environmentLimited) {
        const code = diag.biliCode ?? -1;
        // -412（请求被拦截）/ -509（请求过于频繁）视为可重试；其余视为硬失败
        const retryable = code === -412 || code === -509;
        const msg = `B 站接口返回 code=${code}${diag.message ? `（${diag.message}）` : ''}，环境受限，未采集到任何评论`;
        logger.warn(`CommentCollector bvid=${bvid} environment-limited: ${msg}`);
        return { ok: false, error: msg, retryable, diagnostics: diag };
      }

      const upserted = await commentRepo.bulkAdd(all);
      const stats: CollectorStats = {
        added: upserted.added,
        updated: upserted.updated,
        unchanged: upserted.unchanged,
        pages: page,
        expectedTotal,
      };
      diag.fetched = all.length;
      diag.stored = upserted.added;
      diag.biliCode = biliCode;
      logger.info(
        `CommentCollector bvid=${bvid} sort=${sort} depth=${depth} added=${upserted.added} unchanged=${upserted.unchanged} pages=${page} fetched=${all.length} expected=${expectedTotal} envLimited=${diag.environmentLimited ?? false}`,
      );
      return { ok: true, data: all, fetched: page > 0, stats, diagnostics: diag };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }

  private async collectSubReplies(
    videoId: string,
    aid: number,
    rootRpid: number,
    all: Comment[],
    tierLimit: number,
    bvid: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let pn = 1;
    while (all.length < tierLimit) {
      const query = await this.buildReplyQuery(aid, rootRpid, pn);
      const url = `https://api.bilibili.com/x/v2/reply/reply?${query}`;
      const res = await httpGet<unknown>(url, { signal, referrer: BILI_REFERRER.video(bvid) });
      const parsed = normalizeSubReplies({ videoId, rootRpid, raw: res });
      if (!parsed.ok) break;
      for (const c of parsed.comments) {
        if (all.length >= tierLimit) break;
        all.push(c);
      }
      if (!parsed.hasMore || parsed.nextOffset === null) break;
      pn++;
    }
  }

  /** 一级评论 WBI 签名；mixin key 未就绪时降级为未签名（上层用 biliCode 诊断） */
  private async buildMainQuery(aid: number, mode: number, paginationReply: string | null): Promise<string> {
    try {
      await refreshWbi();
      return await buildWbiQuery({
        oid: aid,
        type: 1,
        mode,
        pagination_reply: paginationReply ?? '',
        web_location: '333.1007',
      });
    } catch {
      const p = new URLSearchParams();
      p.set('oid', String(aid));
      p.set('type', '1');
      p.set('mode', String(mode));
      p.set('pagination_reply', paginationReply ?? '');
      p.set('web_location', '333.1007');
      return p.toString();
    }
  }

  /** 二级回复 WBI 签名；失败降级未签名 */
  private async buildReplyQuery(aid: number, root: number, pn: number): Promise<string> {
    try {
      await refreshWbi();
      return await buildWbiQuery({ oid: aid, type: 1, root, pn, ps: SUB_PS });
    } catch {
      const p = new URLSearchParams();
      p.set('oid', String(aid));
      p.set('type', '1');
      p.set('root', String(root));
      p.set('pn', String(pn));
      p.set('ps', String(SUB_PS));
      return p.toString();
    }
  }
}
