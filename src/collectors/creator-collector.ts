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
import { cachedWithMeta } from '@utils/cache';
import { logger } from '@utils/logger';
import { nowIso } from '@utils/time';
import { newId } from '@utils/id';
import {
  normalizeCreator,
  normalizeCreatorTotals,
  normalizeNavnum,
  normalizeRelationStat,
} from '@normalizers/creator';
import { creatorRepo, creatorSnapshotRepo } from '@repositories/index';
import { creatorSchema, type Creator, type CreatorSnapshot } from '@models/creator';
import { BILI_REFERRER, biliCode, hasBiliData, isBiliBlocked } from '@utils/bili';
import { buildWbiQuery, refreshWbi } from '@utils/wbi';
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
    const query = await buildWbiQuery({ mid: uid, token: '' });
    return `https://api.bilibili.com/x/space/wbi/acc/info?${query}`;
  } catch (e) {
    logger.warn(`WBI refresh/sign failed, fallback to legacy acc/info: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** 网络层错误（超时 / 断网 / 5xx）标记 retryable=true；这类错误换接口也没用 */
function isRetryable(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { retryable?: boolean }).retryable === true;
}

/**
 * 取 UP 主资料：优先 WBI 接口，失败再退 legacy。
 *
 * V0.1.2（P0-2）：降级条件不只是「签名函数抛错」。B 站风控是 **HTTP 200 + code=-352/403**，
 * 这种响应不会抛异常，原实现会直接把它当成成功结果往下走。这里改成：
 * 只要 WBI 响应被判定为不可用（业务码非 0 / 无 data），就用 legacy 接口重试一次。
 */
async function fetchAccInfo(
  uid: number,
  signal?: AbortSignal,
): Promise<{ acc: BiliAccountInfo; via: 'wbi' | 'legacy' | 'card' }> {
  const referrer = BILI_REFERRER.space(uid);
  const wbiUrl = await buildWbiAccInfoUrl(uid);
  if (wbiUrl) {
    try {
      const acc = await httpGet<BiliAccountInfo>(wbiUrl, { signal, referrer });
      if (!isBiliBlocked(acc) && hasBiliData(acc)) return { acc, via: 'wbi' };
      logger.warn(`wbi/acc/info 不可用（code=${biliCode(acc)}），降级 legacy acc/info`);
    } catch (e) {
      // V0.1.3：网络层失败直接抛出，不再逐层降级。
      // 每层都会跑满 3 次退避重试（800/1600/3200ms），三层叠加会让断网时卡十几秒才报错。
      if (isRetryable(e)) throw e;
      logger.warn(`wbi/acc/info 请求失败，降级 legacy: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    const acc = await httpGet<BiliAccountInfo>(`https://api.bilibili.com/x/space/acc/info?mid=${uid}`, {
      signal,
      referrer,
    });
    if (!isBiliBlocked(acc) && hasBiliData(acc)) return { acc, via: 'legacy' };
    logger.warn(`legacy acc/info 不可用（code=${biliCode(acc)}），降级 /x/web-interface/card`);
  } catch (e) {
    if (isRetryable(e)) throw e;
    logger.warn(`legacy acc/info 请求失败，降级 card: ${e instanceof Error ? e.message : e}`);
  }
  // 第三级：/x/web-interface/card（无 WBI，实测在本机匿名环境可用，
  // 见 tests/fixtures/real/card.json：name / fans / attention / level_info 均为真实值）
  const acc = await httpGet<BiliAccountInfo>(
    `https://api.bilibili.com/x/web-interface/card?mid=${uid}&photo=false`,
    { signal, referrer },
  );
  return { acc, via: 'card' };
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
      const { value: fetched, hit } = await cachedWithMeta<CreatorWithTotals>(
        cacheKey,
        5 * 60_000,
        async () => {
          const { acc, via } = await fetchAccInfo(uid, input.signal);
          logger.debug(`CreatorCollector uid=${uid} via=${via}`);
          // V0.1.3（P0-1）：字段映射统一交给 normalizer，不再在 collector 里 `?? 0`。
          const base = normalizeCreator(acc, { now: nowIso() });

          // upstat 在无登录态下可能失败（-352 / 403），不应中断整个 creator 采集；
          // 失败时 totals 为 null（未知），不是 0。
          const stat = await httpGet<unknown>(`https://api.bilibili.com/x/space/upstat?mid=${uid}`, {
            signal: input.signal,
            referrer: BILI_REFERRER.space(uid),
          }).catch((e: unknown) => {
            logger.warn(`upstat unavailable for uid=${uid}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          });
          const totals = normalizeCreatorTotals(stat);

          // 二级补充来源（实机验证可用，且匿名无 Cookie）：
          //   /x/relation/stat  → 真实 follower / following
          //   /x/space/navnum   → 真实 video（投稿数）
          // 只有当一级字段缺失时才请求，避免无谓增加请求量。
          let followers = base.followers;
          let following = base.following;
          let videoCount = base.videoCount;
          if (followers === null || following === null) {
            const rel = await httpGet<unknown>(
              `https://api.bilibili.com/x/relation/stat?vmid=${uid}`,
              { signal: input.signal, referrer: BILI_REFERRER.space(uid) },
            ).catch((e: unknown) => {
              logger.warn(`relation/stat unavailable for uid=${uid}: ${e instanceof Error ? e.message : String(e)}`);
              return null;
            });
            const r = normalizeRelationStat(rel);
            followers = followers ?? r.followers;
            following = following ?? r.following;
            logger.debug(
              `CreatorCollector uid=${uid} relation/stat code=${rel === null ? 'err' : (biliCode(rel) ?? 'n/a')} follower=${r.followers ?? 'null'}`,
            );
          }
          if (videoCount === null) {
            const nav = await httpGet<unknown>(
              `https://api.bilibili.com/x/space/navnum?mid=${uid}`,
              { signal: input.signal, referrer: BILI_REFERRER.space(uid) },
            ).catch((e: unknown) => {
              logger.warn(`navnum unavailable for uid=${uid}: ${e instanceof Error ? e.message : String(e)}`);
              return null;
            });
            videoCount = normalizeNavnum(nav).videoCount;
            logger.debug(
              `CreatorCollector uid=${uid} navnum code=${nav === null ? 'err' : (biliCode(nav) ?? 'n/a')} video=${videoCount ?? 'null'}`,
            );
          }

          const now = nowIso();
          const candidate = {
            ...base,
            followers,
            following,
            videoCount,
            lastCollectedAt: now,
            updatedAt: now,
            _totals: totals,
          };
          // 解析时不期望 _totals 字段
          const { _totals, ...rest } = candidate;
          const parsed = creatorSchema.safeParse(rest);
          if (!parsed.success) throw new Error(`creator zod failed: ${parsed.error.message}`);
          return { ...parsed.data, _totals };
        },
      );

      const now = nowIso();
      const upserted = await creatorRepo.upsertByUid(fetched);
      const totals = fetched._totals;
      const persistedId = upserted.ids[0] ?? fetched.id;

      // V0.1.2（P1-8）：只有真正采集过（非缓存命中）才写时序快照，
      // 否则 5 分钟内的每次 UI 刷新都会往时间序列里塞一个重复点。
      let snapId: string | null = null;
      if (!hit) {
        const snap: CreatorSnapshot = {
          id: newId('cs'),
          creatorId: persistedId,
          timestamp: now,
          followers: fetched.followers,
          following: fetched.following,
          videoCount: fetched.videoCount,
          // 拿不到就是 null，不写 0
          totalViews: totals.totalViews,
          totalLikes: totals.totalLikes,
          totalComments: null,
          totalFavorites: null,
          source: 'bili-api',
        };
        snapId = await creatorSnapshotRepo.add(snap);
      }

      // 用持久化 id 重新读取 creator，避免 UI 拿到临时 id
      const persisted = (await creatorRepo.findById(persistedId)) ?? { ...fetched, id: persistedId };
      logger.info(
        `CreatorCollector uid=${uid} cacheHit=${hit} upsert=${JSON.stringify(
          upserted,
        )} snapCreatorId=${persistedId} snapId=${snapId ?? 'skipped(cache-hit)'} totalsAvailable=${totals.available}`,
      );
      return {
        ok: true,
        data: [persisted],
        fetched: !hit,
        stats: { added: upserted.added, updated: upserted.updated, unchanged: upserted.unchanged },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`CreatorCollector uid=${uid} failed: ${msg}`);
      const retryable = /timeout|abort|5[0-9]{2}|network/i.test(msg);
      return { ok: false, error: msg, retryable };
    }
  }
}