/**
 * CommentCollector（V0.2.1 · 评论采集真实性修复）。
 *
 * 入口：
 *  - collect(input)             按 input.context.commentOptions 配置采集
 *  - collectComments(bvid, opts) 直接以编程方式采集（测试 / 任务系统调用）
 *
 * 采集档位（tier）：quick=50 / standard=200 / deep=500 / max=1000
 * 排序（sort）：hot → mode=3，time → mode=2
 * 深度（depth）：top=仅一级；deep=展开前 30 个一级的二级回复；advanced=前 100 个
 *
 * ── 一级评论协议（V0.2.1 P0-1 修正）───────────────────────────────────────────
 * 端点：`/x/v2/reply/wbi/main`（WBI 签名）
 * 参数：oid, type=1, mode, pagination_str, plat=1, seek_rpid='', web_location
 *
 *   - **分页参数是 `pagination_str`，不是 `pagination_reply`。**
 *     V0.2.0 错误地把上一页的 `next_offset` 直接塞进 `pagination_reply` URL 参数，
 *     服务端不认，于是每次请求都返回第一页 → 表现为「只采到极少评论」。
 *   - 分页值是一个 **JSON 字符串**，外层包 `{"offset": ...}`：
 *       首屏：  pagination_str = {"offset":""}
 *       后续页：pagination_str = {"offset":"<上一页 data.cursor.pagination_reply.next_offset>"}
 *     而 `next_offset` 本身已经是 JSON 字符串，形如
 *       `{"type":1,"direction":1,"data":{"pn":3}}`（热度）或
 *       `{"type":3,"direction":1,"data":{"cursor":N}}`（时间），须 **原样放入** offset 字段，
 *     由 URL 编码整体传输 —— 不要二次解析、不要自己拼 pn。
 *
 * 协议来源（不凭记忆）：
 *   - bilibili-API-collect `docs/comment/list.md`：懒加载分页用 `pagination_str`，
 *     `{"offset": ...}`，offset 取上一页 `cursor.pagination_reply.next_offset`；
 *     `pagination_reply.next_offset` 为 JSON 字符串
 *     （`{"type":1,"direction":1,"data":{"pn":N}}` / `{"type":3,...,"data":{"cursor":N}}`）。
 *   - 真实响应 dump 与多个维护中的实现（bilibili-api、bilibili_comments_crawl）一致：
 *     一级请求参数含 `pagination_str` / `plat` / `seek_rpid` / `web_location`。
 *
 * ── 二级回复协议（V0.2.1 P0-5 修正）──────────────────────────────────────────
 * 端点：`/x/v2/reply/reply?oid={aid}&type=1&root={rpid}&pn={n}&ps={ps}`
 *   - 二级回复是 **pn 页码分页**（pn=1,2,3…），`ps` 上限 20。
 *   - **不读取** `pagination_reply.next_offset`（那是给一级接口用的）。
 *   - 结束条件：本页 `replies.length < ps`（或接口显式声明结束）。
 *
 * ── 分页前进不变量（P0-3）───────────────────────────────────────────────────
 * 维护 previousOffset / currentOffset / seenRpidStr：
 *   1. nextOffset === previousOffset → 立即停止，paginationStalled
 *   2. 本页唯一新增 === 0         → 停止（避免死循环烧请求）
 *   3. 连续两页 rpid 完全重复      → 停止，duplicatePageDetected
 *   4. is_end=true               → 正常结束
 *   5. 达到 tierLimit            → 正常结束
 *   6. 达到 maxPages             → partial（不伪装完整）
 *
 * ── 跨页去重（P0-4）────────────────────────────────────────────────────────
 * normalizer 只能做「单页内去重」；整个采集过程的去重由 Collector 的
 * `seenRpidStr` 承担。`fetched`（原始抓取）与 `unique`（去重后）分开统计。
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
  /** 二级回复对多个 root 的有界并发度（默认 3，限流时自动降到 1） */
  subConcurrency?: number;
}

const SUB_PS = 20;
const TOP_EXPAND_DEEP = 30;
const TOP_EXPAND_ADVANCED = 100;
/** 二级回复单个 root 的安全页上限 */
const SUB_MAX_PAGES = 50;
const DEFAULT_SUB_CONCURRENCY = 3;

/**
 * 构造一级评论请求 query（V0.2.1 P0-1）。
 *
 * @param aid            视频 aid（作为 oid）
 * @param mode           排序：2=按时间 / 3=按热度
 * @param paginationStr  分页字符串；首屏传 `{"offset":""}`，
 *                       后续页传 `{"offset":"<上一页 next_offset>"}`
 */
export async function buildCommentMainQuery(
  aid: number,
  mode: number,
  paginationStr: string,
): Promise<string> {
  const base: Record<string, string | number> = {
    oid: aid,
    type: 1,
    mode,
    pagination_str: paginationStr,
    plat: 1,
    seek_rpid: '',
    web_location: '1315875',
  };
  try {
    await refreshWbi();
    return await buildWbiQuery(base);
  } catch {
    // WBI 未就绪：降级未签名（上层用 biliCode 诊断「环境受限」）
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(base)) p.set(k, String(v));
    return p.toString();
  }
}

/** 首屏分页串 */
export function firstPagePaginationStr(): string {
  return JSON.stringify({ offset: '' });
}

/**
 * 把上一页的 `next_offset` 包装成下一页的 `pagination_str`（P0-1）。
 * `nextOffset` 本身已是 JSON 字符串，原样放入 offset，不可再解析重组。
 */
export function nextPagePaginationStr(nextOffset: string): string {
  return JSON.stringify({ offset: nextOffset });
}

/** 分页是否前进：同一 offset 重复出现 → 视为卡住（P0-3 不变量 1） */
export function isPaginationStalled(prev: string, next: string): boolean {
  return prev !== '' && prev === next;
}

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
    /** 跨页去重（P0-4）：整个采集过程共用 */
    const seenRpidStr = new Set<string>();
    /** 真正入库的（去重后）评论 */
    const unique: Comment[] = [];
    /** 原始抓取条数（含重复） */
    let fetchedRaw = 0;
    let expectedTotal = 0;
    let biliCode: number | undefined;
    let lastOffset = '';
    let prevPageKeys: string | null = null;
    let page = 0;
    let paginationAdvanced = false;

    try {
      while (unique.length < tierLimit && page < maxPages) {
        page++;
        const paginationStr =
          page === 1 ? firstPagePaginationStr() : nextPagePaginationStr(lastOffset);
        const query = await buildCommentMainQuery(aid, mode, paginationStr);
        const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${query}`;
        const res = await httpGet<unknown>(url, { signal, referrer: BILI_REFERRER.video(bvid) });
        const parsed = normalizeCommentPage({ videoId: video.id, raw: res });
        biliCode = parsed.code;
        if (!parsed.ok) {
          // code != 0（风控 / 未登录 / 接口异常）→ 环境受限，必须明确告知
          diag.environmentLimited = true;
          diag.biliCode = parsed.code;
          diag.message = parsed.message;
          break;
        }
        fetchedRaw += parsed.comments.length;
        if (parsed.total > expectedTotal) expectedTotal = parsed.total;
        diag.pages = page;

        // ── 不变量 3：连续两页 rpid 完全重复 ──
        const pageKeys = parsed.comments.map((c) => c.rpidStr).join('#');
        if (prevPageKeys !== null && pageKeys !== '' && pageKeys === prevPageKeys) {
          diag.duplicatePageDetected = true;
          logger.warn(
            `CommentCollector bvid=${bvid} duplicate page detected at page=${page} (identical rpid set), stopping`,
          );
          break;
        }
        prevPageKeys = pageKeys;

        // ── 不变量 2 + 跨页去重：本页唯一新增为 0 → 停止 ──
        let newThisPage = 0;
        for (const c of parsed.comments) {
          if (unique.length >= tierLimit) break;
          if (seenRpidStr.has(c.rpidStr)) continue; // 跨页去重（P0-4）
          seenRpidStr.add(c.rpidStr);
          unique.push(c);
          newThisPage++;
        }
        if (newThisPage === 0 && parsed.comments.length > 0) {
          diag.paginationStalled = true;
          logger.warn(
            `CommentCollector bvid=${bvid} no new unique reply at page=${page} (server repeated page), stopping`,
          );
          break;
        }

        // ── 不变量 4：is_end 正常结束 ──
        if (!parsed.hasMore || parsed.nextOffset === null) break;

        // ── 不变量 1：offset 未前进 → 立即停止 ──
        if (isPaginationStalled(lastOffset, parsed.nextOffset)) {
          diag.paginationStalled = true;
          logger.warn(
            `CommentCollector bvid=${bvid} pagination stalled at page=${page}: next_offset unchanged (${parsed.nextOffset}), stopping`,
          );
          break;
        }
        lastOffset = parsed.nextOffset;
        paginationAdvanced = true;
      }

      // ── 不变量 6：达到 maxPages → partial（不伪装完整）──
      if (page >= maxPages && unique.length < tierLimit) {
        diag.partial = true;
        logger.warn(`CommentCollector bvid=${bvid} hit maxPages=${maxPages}, marking partial`);
      }

      // 二级回复（深度模式）：对满足条件的一级评论展开
      if (depth !== 'top' && unique.length > 0) {
        const expandN = depth === 'advanced' ? TOP_EXPAND_ADVANCED : TOP_EXPAND_DEEP;
        const roots = unique
          .filter((c) => c.replyLevel === 1 && c.replyCount >= 1)
          .slice(0, expandN)
          .map((c) => ({ rpid: c.rpid, rpidStr: c.rpidStr }));
        const concurrency = Math.max(1, opts.subConcurrency ?? DEFAULT_SUB_CONCURRENCY);
        await this.expandSubRepliesBounded(
          video.id,
          aid,
          roots,
          concurrency,
          seenRpidStr,
          unique,
          tierLimit,
          bvid,
          signal,
          diag,
        );
      }

      // P0-D：环境受限且一条都没拿到 → 明确失败，绝不伪装「采集完成」
      if (unique.length === 0 && diag.environmentLimited) {
        const code = diag.biliCode ?? -1;
        const retryable = code === -412 || code === -509;
        const msg = `B 站接口返回 code=${code}${diag.message ? `（${diag.message}）` : ''}，环境受限，未采集到任何评论`;
        logger.warn(`CommentCollector bvid=${bvid} environment-limited: ${msg}`);
        return { ok: false, error: msg, retryable, diagnostics: diag };
      }

      const upserted = await commentRepo.bulkAdd(unique);
      const stats: CollectorStats = {
        added: upserted.added,
        updated: upserted.updated,
        unchanged: upserted.unchanged,
        pages: page,
        expectedTotal,
        fetched: fetchedRaw,
        unique: unique.length,
      };
      diag.fetched = fetchedRaw;
      diag.stored = upserted.added;
      diag.biliCode = biliCode;
      diag.paginationAdvanced = paginationAdvanced;
      // 关键可观测性日志（P0-3）：一眼看出是否卡在第一页
      logger.info(
        `CommentCollector bvid=${bvid} sort=${sort} depth=${depth} pages=${page} fetched=${fetchedRaw} unique=${unique.length} ` +
          `added=${upserted.added} unchanged=${upserted.unchanged} expected=${expectedTotal} ` +
          `paginationAdvanced=${paginationAdvanced} paginationStalled=${diag.paginationStalled ?? false} ` +
          `duplicatePage=${diag.duplicatePageDetected ?? false} envLimited=${diag.environmentLimited ?? false} partial=${diag.partial ?? false}`,
      );
      return { ok: true, data: unique, fetched: page > 0, stats, diagnostics: diag };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }

  /**
   * 对多个 root 做**有界并发**（P0-5 / 性能原则）：
   * 不要把 30/100 个 root 一次性 Promise.all 爆掉。
   */
  private async expandSubRepliesBounded(
    videoId: string,
    aid: number,
    roots: Array<{ rpid: number; rpidStr: string }>,
    concurrency: number,
    seenRpidStr: Set<string>,
    unique: Comment[],
    tierLimit: number,
    bvid: string,
    signal: AbortSignal | undefined,
    diag: CollectorDiagnostics,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, roots.length) }, async () => {
      while (cursor < roots.length) {
        if (unique.length >= tierLimit) return;
        if (signal?.aborted) return;
        const root = roots[cursor++]!;
        await this.collectSubReplies(
          videoId,
          aid,
          root.rpid,
          root.rpidStr,
          seenRpidStr,
          unique,
          tierLimit,
          bvid,
          signal,
          diag,
        );
      }
    });
    await Promise.all(workers);
  }

  /**
   * 采集单个根评论下的二级回复（P0-5：pn 页码分页 + 末页 < ps 停止 + 去重）。
   */
  private async collectSubReplies(
    videoId: string,
    aid: number,
    rootRpid: number,
    rootRpidStr: string,
    seenRpidStr: Set<string>,
    unique: Comment[],
    tierLimit: number,
    bvid: string,
    signal: AbortSignal | undefined,
    diag: CollectorDiagnostics,
  ): Promise<void> {
    let prevKeys: string | null = null;
    for (let pn = 1; pn <= SUB_MAX_PAGES; pn++) {
      if (unique.length >= tierLimit || signal?.aborted) return;
      const query = await this.buildReplyQuery(aid, rootRpid, pn);
      const url = `https://api.bilibili.com/x/v2/reply/reply?${query}`;
      let res: unknown;
      try {
        res = await httpGet<unknown>(url, { signal, referrer: BILI_REFERRER.video(bvid) });
      } catch (e) {
        // 单个 root 失败不影响整批（best-effort）
        logger.warn(
          `CommentCollector sub-reply failed root=${rootRpid} pn=${pn}: ${e instanceof Error ? e.message : String(e)}`,
        );
        diag.partial = true;
        return;
      }
      const parsed = normalizeSubReplies({ videoId, rootRpid, rootRpidStr, raw: res });
      if (!parsed.ok) {
        // 二级被风控：标记受限但不中断一级已拿到的数据
        diag.environmentLimited = true;
        diag.biliCode = diag.biliCode ?? parsed.code;
        logger.warn(
          `CommentCollector sub-reply env-limited root=${rootRpid} pn=${pn} code=${parsed.code}`,
        );
        return;
      }
      // 相同页检测（P0-5 不变量）
      const keys = parsed.comments.map((c) => c.rpidStr).join('#');
      if (prevKeys !== null && keys !== '' && keys === prevKeys) {
        diag.duplicatePageDetected = true;
        return;
      }
      prevKeys = keys;

      for (const c of parsed.comments) {
        if (unique.length >= tierLimit) break;
        if (seenRpidStr.has(c.rpidStr)) continue; // 去重（P0-5）
        seenRpidStr.add(c.rpidStr);
        unique.push(c);
      }
      // 结束条件：本页原始条数不足一页 → 到底了（P0-5）
      if (parsed.total < SUB_PS) return;
    }
    // 走到这里说明达到 SUB_MAX_PAGES，仍未取完 → 标记不完整
    diag.partial = true;
  }

  /** 二级回复 WBI 签名；失败降级未签名 */
  private async buildReplyQuery(aid: number, root: number, pn: number): Promise<string> {
    const base: Record<string, string | number> = { oid: aid, type: 1, root, pn, ps: SUB_PS };
    try {
      await refreshWbi();
      return await buildWbiQuery(base);
    } catch {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(base)) p.set(k, String(v));
      return p.toString();
    }
  }
}
