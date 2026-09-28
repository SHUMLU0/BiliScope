/**
 * VideoCollector
 * 入口：
 *   collectByCreator(uid) —— 拉取全部视频 + 单独 stat + 写入 snapshot
 *   collectStat(bvid)      —— 单独 stat
 *
 * V0.1.1 修复：
 *   - /x/space/wbi/arc/search 必须带 WBI 签名（wts + w_rid），否则 B 站返回 -352 风控
 *   - 优先 signWbi()，失败时降级为带 wts 的请求并明确报错
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { normalizeVideoList, normalizeVideoStat } from '@normalizers/video';
import { creatorRepo, videoRepo, videoSnapshotRepo } from '@repositories/index';
import { videoSnapshotSchema, type Video, type VideoSnapshot } from '@models/video';
import { BILI_REFERRER, biliCode, isBiliBlocked } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
import type { Collector, CollectorInput, CollectorResult } from './types';

/** 构造带 WBI 签名的 arc/search URL；失败返回 null（调用方降级） */
async function buildWbiArcSearchUrl(uid: number, pn: number, ps: number): Promise<string | null> {
  try {
    await refreshWbi();
    const query = await buildWbiQuery({
      mid: uid,
      pn,
      ps,
      order: 'pubdate',
      platform: 'web',
      web_location: 40020,
      tid: 0,
      keyword: '',
    });
    return `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;
  } catch (e) {
    logger.warn(`WBI arc/search sign failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function legacyArcSearchUrl(uid: number, pn: number, ps: number): string {
  const q = encodeQuery({ mid: uid, pn, ps, order: 'pubdate', platform: 'web', web_location: 40020 });
  return `https://api.bilibili.com/x/space/arc/search?${q}`;
}

function encodeQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * 拉一页投稿列表。
 * V0.1.2（P0-2）：WBI 响应 HTTP 200 但 code=-352/403 时也要降级到 legacy arc/search，
 * 而不是只在签名抛错时降级（原实现在真实环境下几乎不会触发降级）。
 */
async function fetchArcSearchPage(
  uid: number,
  pn: number,
  ps: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const referrer = BILI_REFERRER.space(uid);
  const wbiUrl = await buildWbiArcSearchUrl(uid, pn, ps);
  if (wbiUrl) {
    try {
      const res = await httpGet<unknown>(wbiUrl, { signal, referrer });
      if (!isBiliBlocked(res)) return res;
      logger.warn(`wbi/arc/search 被拦（code=${biliCode(res)}），降级 legacy arc/search`);
    } catch (e) {
      logger.warn(`wbi/arc/search 请求失败，降级 legacy: ${e instanceof Error ? e.message : e}`);
    }
  }
  return httpGet<unknown>(legacyArcSearchUrl(uid, pn, ps), { signal, referrer });
}

export class VideoCollector implements Collector<Video> {
  readonly name = 'video';

  async collect(input: CollectorInput): Promise<CollectorResult<Video>> {
    return this.collectByCreator(Number(input.targetId), input.signal);
  }

  /**
   * 拉取某 UP 主的投稿列表。
   *
   * V0.1.3（P0-5）：默认**不再**对每个视频逐个请求 /x/web-interface/view。
   *   旧实现最坏 7 页 × 30 条 = 210 次额外请求，极易触发风控且毫无必要 ——
   *   投稿列表本身已提供 play / video_review / comment / created / length / author / mid。
   *   只有显式传入 `fetchDetails` 时才补详情，且受 `maxDetailFetches` 限制。
   *
   * V0.1.3（P0-6）：列表里给出的 play 会写成一条初始 VideoSnapshot（其余指标 null），
   *   这样以后才能回答"刚发布时多少播放，现在多少播放"。
   */
  async collectByCreator(
    uid: number,
    signal?: AbortSignal,
    opts: { fetchDetails?: boolean; maxDetailFetches?: number } = {},
  ): Promise<CollectorResult<Video>> {
    if (!Number.isFinite(uid) || uid <= 0) {
      return { ok: false, error: `invalid uid: ${uid}`, retryable: false };
    }
    const creator = await creatorRepo.findByUid(uid);
    if (!creator) {
      return { ok: false, error: `creator not found for uid=${uid}`, retryable: false };
    }
    const fetchDetails = opts.fetchDetails === true;
    const maxDetailFetches = opts.maxDetailFetches ?? 10;

    try {
      const out: Video[] = [];
      let pn = 1;
      const ps = 30;
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      let listRequests = 0;
      let detailRequests = 0;
      while (pn <= 7) {
        const res = await fetchArcSearchPage(uid, pn, ps, signal);
        listRequests++;
        const videos = normalizeVideoList(res, { creatorId: creator.id });
        if (!videos.length) break;
        for (const v of videos) {
          const upserted = await videoRepo.upsertByBvid(v);
          const actualVideoId = upserted.ids[0] ?? v.id;
          added += upserted.added;
          updated += upserted.updated;
          unchanged += upserted.unchanged;
          if (upserted.added || upserted.updated) {
            out.push({ ...v, id: actualVideoId });
          }
          // 列表里自带的播放量 → 初始 snapshot（其余指标保持 null）
          if (typeof v.views === 'number') {
            const snap: VideoSnapshot = {
              id: newId('vs'),
              videoId: actualVideoId,
              timestamp: nowIso(),
              views: v.views,
              likes: null,
              coins: null,
              favorites: null,
              shares: null,
              comments: null,
              danmaku: null,
              source: 'bili-api',
            };
            const parsed = videoSnapshotSchema.safeParse(snap);
            if (parsed.success) await videoSnapshotRepo.add(parsed.data);
          }
          // 仅在显式要求时补详情，且不超过上限
          if (fetchDetails && detailRequests < maxDetailFetches) {
            detailRequests++;
            try {
              const stat = await httpGet<unknown>(
                `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(v.bvid)}`,
                { signal, referrer: BILI_REFERRER.video(v.bvid) },
              );
              const norm = normalizeVideoStat(stat);
              if (norm) {
                const snap: VideoSnapshot = {
                  id: newId('vs'),
                  videoId: actualVideoId,
                  timestamp: nowIso(),
                  views: norm.views ?? null,
                  likes: norm.likes ?? null,
                  coins: norm.coins,
                  favorites: norm.favorites,
                  shares: norm.shares,
                  comments: norm.comments,
                  danmaku: norm.danmaku,
                  source: 'bili-api',
                };
                const parsed = videoSnapshotSchema.safeParse(snap);
                if (parsed.success) await videoSnapshotRepo.add(parsed.data);
              }
            } catch (e) {
              logger.warn(`stat failed for bvid=${v.bvid}: ${e instanceof Error ? e.message : e}`);
            }
          }
        }
        if (videos.length < ps) break;
        pn++;
      }
      logger.info(
        `VideoCollector uid=${uid} collected ${out.length} (added=${added} updated=${updated} unchanged=${unchanged}) ` +
          `list requests = ${listRequests}, detail view requests = ${detailRequests}`,
      );
      return { ok: true, data: out, fetched: true, stats: { added, updated, unchanged } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /timeout|abort|5[0-9]{2}|network|rate/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }

  async collectStat(bvid: string, signal?: AbortSignal): Promise<CollectorResult<Video>> {
    try {
      const res = await httpGet<unknown>(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        { signal, referrer: BILI_REFERRER.video(bvid) },
      );
      const norm = normalizeVideoStat(res);
      if (!norm) return { ok: false, error: 'stat parse failed', retryable: false };
      const video = await videoRepo.findByBvid(bvid);
      if (video) {
        const snap: VideoSnapshot = {
          id: newId('vs'),
          videoId: video.id,
          timestamp: nowIso(),
          views: norm.views,
          likes: norm.likes,
          coins: norm.coins,
          favorites: norm.favorites,
          shares: norm.shares,
          comments: norm.comments,
          danmaku: norm.danmaku,
          source: 'bili-api',
        };
        const parsed = videoSnapshotSchema.safeParse(snap);
        if (parsed.success) await videoSnapshotRepo.add(parsed.data);
      }
      return { ok: true, data: [], fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, retryable: /timeout|abort|5[0-9]{2}|network/i.test(msg) };
    }
  }
}