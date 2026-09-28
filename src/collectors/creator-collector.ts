/**
 * CreatorCollector
 * 公开接口：
 *   GET https://api.bilibili.com/x/space/acc/info?mid={uid}
 *   GET https://api.bilibili.com/x/space/upstat?mid={uid}
 *   GET https://api.bilibili.com/x/relation/stat?mid={uid}    （兜底）
 */

import { httpGet } from '@utils/http';
import { cached } from '@utils/cache';
import { logger } from '@utils/logger';
import { nowIso } from '@utils/time';
import { newId } from '@utils/id';
import { normalizeCreatorTotals } from '@normalizers/creator';
import { creatorRepo, creatorSnapshotRepo } from '@repositories/index';
import { creatorSchema, type Creator, type CreatorSnapshot } from '@models/creator';
import type { Collector, CollectorInput, CollectorResult } from './types';

interface BiliAccountInfo {
  code?: number;
  data?: {
    mid?: number;
    name?: string;
    face?: string;
    sign?: string;
    level_info?: { current_level?: number };
    fans?: number;
    following?: number;
    archive_count?: number;
  };
}

interface CreatorWithTotals extends Creator {
  _totals: ReturnType<typeof normalizeCreatorTotals>;
}

export class CreatorCollector implements Collector<Creator> {
  readonly name = 'creator';

  async collect(input: CollectorInput): Promise<CollectorResult<Creator>> {
    const uid = Number(input.targetId);
    if (!Number.isFinite(uid) || uid <= 0) {
      return { ok: false, error: `invalid uid: ${input.targetId}`, retryable: false };
    }

    const cacheKey = `creator:${uid}`;
    try {
      const fetched = await cached<CreatorWithTotals>(cacheKey, 5 * 60_000, async () => {
        const acc = await httpGet<BiliAccountInfo>('https://api.bilibili.com/x/space/acc/info', {
          signal: input.signal,
        });
        const d = acc.data;
        if (!d || typeof d !== 'object' || !d.mid) {
          throw new Error(`acc/info returned invalid data`);
        }
        const stat = await httpGet<unknown>('https://api.bilibili.com/x/space/upstat', {
          signal: input.signal,
        }).catch(() => null);
        const totals = normalizeCreatorTotals(stat);
        const now = nowIso();
        const candidate = {
          id: newId('cr'),
          uid: d.mid,
          name: d.name ?? `uid_${d.mid}`,
          avatar: d.face || undefined,
          sign: d.sign ?? '',
          level: d.level_info?.current_level ?? 0,
          followers: d.fans ?? 0,
          following: d.following ?? 0,
          videoCount: d.archive_count ?? 0,
          spaceUrl: `https://space.bilibili.com/${d.mid}/`,
          lastCollectedAt: now,
          createdAt: now,
          updatedAt: now,
          source: 'bili-api' as const,
          _totals: totals,
        };
        // 解析时不期望 _totals 字段
        const { _totals, ...rest } = candidate;
        const parsed = creatorSchema.safeParse(rest);
        if (!parsed.success) throw new Error(`creator zod failed: ${parsed.error.message}`);
        return { ...parsed.data, _totals };
      });

      const now = nowIso();
      const upserted = await creatorRepo.upsertByUid(fetched);
      const totals = fetched._totals;

      const snap: CreatorSnapshot = {
        id: newId('cs'),
        creatorId: upserted.ids[0] ?? fetched.id,
        timestamp: now,
        followers: fetched.followers,
        following: fetched.following,
        videoCount: fetched.videoCount,
        totalViews: totals.totalViews,
        totalLikes: totals.totalLikes,
        totalComments: 0,
        totalFavorites: 0,
        source: 'bili-api',
      };
      await creatorSnapshotRepo.add(snap);
      logger.info(
        `CreatorCollector uid=${uid} upsert=${JSON.stringify(upserted)} snapCreatorId=${snap.creatorId} snapId=${snap.id}`,
      );
      return { ok: true, data: [fetched], fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`CreatorCollector uid=${uid} failed: ${msg}`);
      const retryable = /timeout|abort|5[0-9]{2}|network/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}