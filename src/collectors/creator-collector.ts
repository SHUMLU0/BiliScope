/**
 * CreatorCollector
 * 公开接口：
 *   GET https://api.bilibili.com/x/space/acc/info?mid={uid}              （legacy, deprecated by B 站）
 *   GET https://api.bilibili.com/x/space/wbi/acc/info?mid={uid}          （new, requires WBI signing）
 *   GET https://api.bilibili.com/x/space/upstat?mid={uid}                （totals，登录态下更稳定）
 *
 * V0.1.1 修复（独立验收反馈）：
 *   - acc/info URL 缺少 ?mid={uid} → 已补全
 *   - acc/info 已被 B 站弃用 → 切到 wbi/acc/info；WBI 失败时降级到 legacy 接口
 *   - upstat URL 缺少 ?mid={uid} → 已补全
 *   - upstat 在无登录态下可能失败 → 改为非致命，totals 退化为 0
 *   - collect 返回的 Creator 使用 upsert 后的真实 DB id（避免 UI 用临时 id 查不到）
 */

import { httpGet } from '@utils/http';
import { cached } from '@utils/cache';
import { logger } from '@utils/logger';
import { nowIso } from '@utils/time';
import { newId } from '@utils/id';
import { normalizeCreatorTotals } from '@normalizers/creator';
import { creatorRepo, creatorSnapshotRepo } from '@repositories/index';
import { creatorSchema, type Creator, type CreatorSnapshot } from '@models/creator';
import { refreshWbi, signWbi } from '@utils/wbi';
import type { Collector, CollectorInput, CollectorResult } from './types';

interface BiliAccountInfo {
  code?: number;
  message?: string;
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

/** 构造带 WBI 签名的 wbi/acc/info URL；失败返回 null（调用方降级到 legacy 接口） */
async function buildWbiAccInfoUrl(uid: number): Promise<string | null> {
  try {
    await refreshWbi();
    const signed = await signWbi({ mid: uid, token: '' });
    const qs = new URLSearchParams(signed).toString();
    return `https://api.bilibili.com/x/space/wbi/acc/info?${qs}`;
  } catch (e) {
    logger.warn(`WBI refresh/sign failed, fallback to legacy acc/info: ${e instanceof Error ? e.message : e}`);
    return null;
  }
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
        const wbiUrl = await buildWbiAccInfoUrl(uid);
        const acc = await httpGet<BiliAccountInfo>(
          wbiUrl ?? `https://api.bilibili.com/x/space/acc/info?mid=${uid}`,
          { signal: input.signal },
        );
        const d = acc.data;
        if (!d || typeof d !== 'object' || !d.mid) {
          throw new Error(`acc/info returned invalid data (code=${acc.code ?? 'n/a'} msg=${acc.message ?? 'n/a'})`);
        }
        // upstat 在无登录态下可能失败（-352 / 403），不应中断整个 creator 采集
        const stat = await httpGet<unknown>(
          `https://api.bilibili.com/x/space/upstat?mid=${uid}`,
          { signal: input.signal },
        ).catch((e: unknown) => {
          logger.warn(`upstat unavailable for uid=${uid}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
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
      const persistedId = upserted.ids[0] ?? fetched.id;

      const snap: CreatorSnapshot = {
        id: newId('cs'),
        creatorId: persistedId,
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

      // 用持久化 id 重新读取 creator，避免 UI 拿到临时 id
      const persisted = (await creatorRepo.findById(persistedId)) ?? { ...fetched, id: persistedId };
      logger.info(
        `CreatorCollector uid=${uid} upsert=${JSON.stringify(upserted)} snapCreatorId=${persistedId} snapId=${snap.id}`,
      );
      return { ok: true, data: [persisted], fetched: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`CreatorCollector uid=${uid} failed: ${msg}`);
      const retryable = /timeout|abort|5[0-9]{2}|network/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}