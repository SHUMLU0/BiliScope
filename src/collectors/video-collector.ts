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
import { refreshWbi, signWbi } from '@utils/wbi';
import type { Collector, CollectorInput, CollectorResult } from './types';

/** 构造带 WBI 签名的 arc/search URL；失败返回 null（调用方降级） */
async function buildWbiArcSearchUrl(uid: number, pn: number, ps: number): Promise<string | null> {
  try {
    await refreshWbi();
    const signed = await signWbi({
      mid: uid,
      pn,
      ps,
      order: 'pubdate',
      platform: 'web',
      web_location: 40020,
      tid: 0,
      keyword: '',
    });
    const qs = new URLSearchParams(signed).toString();
    return `https://api.bilibili.com/x/space/wbi/arc/search?${qs}`;
  } catch (e) {
    logger.warn(`WBI arc/search sign failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export class VideoCollector implements Collector<Video> {
  readonly name = 'video';

  async collect(input: CollectorInput): Promise<CollectorResult<Video>> {
    return this.collectByCreator(Number(input.targetId), input.signal);
  }

  async collectByCreator(uid: number, signal?: AbortSignal): Promise<CollectorResult<Video>> {
    if (!Number.isFinite(uid) || uid <= 0) {
      return { ok: false, error: `invalid uid: ${uid}`, retryable: false };
    }
    const creator = await creatorRepo.findByUid(uid);
    if (!creator) {
      return { ok: false, error: `creator not found for uid=${uid}`, retryable: false };
    }

    try {
      const out: Video[] = [];
      let pn = 1;
      const ps = 30;
      // 阶段化：最多 200 条 / UP 主
      while (pn <= 7) {
        const wbiUrl = await buildWbiArcSearchUrl(uid, pn, ps);
        const url =
          wbiUrl ??
          // 降级：带 wts 但无 w_rid，B 站通常会返回 -352；保留以暴露明确错误
          `https://api.bilibili.com/x/space/wbi/arc/search?mid=${uid}&pn=${pn}&ps=${ps}&order=pubdate&platform=web&web_location=40020`;
        const res = await httpGet<unknown>(url, { signal });
        const videos = normalizeVideoList(res, { creatorId: creator.id });
        if (!videos.length) break;
        for (const v of videos) {
          const upserted = await videoRepo.upsertByBvid(v);
          const actualVideoId = upserted.ids[0] ?? v.id;
          if (upserted.added || upserted.updated) {
            out.push({ ...v, id: actualVideoId });
          }
          // 拉单条 stat
          try {
            const stat = await httpGet<unknown>(
              `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(v.bvid)}`,
              { signal },
            );
            const norm = normalizeVideoStat(stat);
            if (norm) {
              const snap: VideoSnapshot = {
                id: newId('vs'),
                videoId: actualVideoId,
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
          } catch (e) {
            logger.warn(`stat failed for bvid=${v.bvid}: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (videos.length < ps) break;
        pn++;
      }
      logger.info(`VideoCollector uid=${uid} collected ${out.length}`);
      return { ok: true, data: out, fetched: true };
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
        { signal },
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