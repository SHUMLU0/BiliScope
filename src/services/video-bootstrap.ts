/**
 * video-bootstrap —— 「裸 BV → 持久化 Video」依赖闭环（V0.2.2）。
 *
 * ── 解决的问题 ───────────────────────────────────────────────────────────────
 * V0.2.1 及以前，评论页允许用户直接输入合法 BV，但调用链是：
 *   comment-page → CommentCollector.collectComments(bvid)
 *     → videoRepo.findByBvid(bvid)
 *     → 找不到本地 Video 就直接返回 `video not found for bvid=...`
 * 也就是说：**评论模块没有「BV → 本地 Video 记录」的 bootstrap 流程**。
 * 只有先经过 VideoCollector（UP 主投稿列表）才会存在 Video，评论页对裸 BV 完全不可用。
 *
 * ── 目标行为 ─────────────────────────────────────────────────────────────────
 *   本地已有 Video → 直接复用，**0 次额外 `/view` 请求**（性能要求）
 *   本地没有 Video → 调 `/x/web-interface/view?bvid=` → 校验 → 建/复用 Creator
 *                  → normalize → `videoRepo.upsertByBvid()` → 返回**持久化** Video
 *
 * ── 协议（Source of Truth：真实请求 / 真实响应 fixture，不凭记忆）─────────────
 *   GET https://api.bilibili.com/x/web-interface/view?bvid=<BV>
 *   Referer: https://www.bilibili.com/video/<BV>
 *   Auth: 无（匿名，credentials:'omit'，不读 Cookie）
 *   响应：{ code, message, ttl, data: { bvid, aid, title, desc, pic, pubdate,
 *           duration, tname, owner:{mid,name,face}, stat:{view,...} } }
 *   业务码：0=成功；-404=稿件不存在；-400=请求错误；62002=稿件不可见；
 *           -403 / -101 / -352 等=风控或权限（见 BILI_BLOCKED_CODES）
 *
 * ── 真实性约束 ───────────────────────────────────────────────────────────────
 *   - HTTP / 网络失败 → 保留真实错误消息（不吞成 "视频不存在"）
 *   - `code !== 0`   → 明确「视频信息获取失败」并带上真实业务码
 *   - `data` 缺失    → 失败，不写脏数据
 *   - bvid / aid 缺失或非法 → 失败（由 normalizer 的 zod 兜住）
 *   - Creator 统计 / level 未知 → 保持既有 null 语义，**绝不伪造 followers 等**
 */

import { httpGet, type HttpError } from '@utils/http';
import { logger } from '@utils/logger';
import { BILI_REFERRER, biliCode, isBiliBlocked } from '@utils/bili';
import { creatorRepo, videoRepo } from '@repositories/index';
import { normalizeVideoDetail } from '@normalizers/video';
import { creatorSchema, type Creator } from '@models/creator';
import type { Video } from '@models/video';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';

export interface BootstrapOk {
  ok: true;
  video: Video;
  /** 本次是否真的请求了 `/x/web-interface/view`（false = 本地命中缓存） */
  fetched: boolean;
  /** 是否新建了 Video 记录 */
  createdVideo: boolean;
  /** 是否新建了最小 Creator 记录 */
  createdCreator: boolean;
}

export interface BootstrapErr {
  ok: false;
  error: string;
  retryable: boolean;
  /** 单独标注「B 站视频信息获取失败（含业务码）」，便于 UI 与「本地无记录」区分 */
  metadataFailed?: boolean;
  biliCode?: number;
  httpStatus?: number;
}

export type BootstrapResult = BootstrapOk | BootstrapErr;

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

/** 业务码 → 人类可读说明（用于 UI 区分「下架/私密」与「被风控」） */
function describeViewCode(code: number): string {
  switch (code) {
    case -404:
      return '稿件不存在（可能已删除、下架或 BV 号有误）';
    case -400:
      return '请求错误（BV 号格式不正确）';
    case 62002:
      return '稿件不可见（私密 / 审核中 / 被 UP 主设为不可见）';
    case -403:
      return '访问权限不足（B 站拒绝访问该稿件详情）';
    default:
      return `B 站返回业务码 ${code}`;
  }
}

/**
 * 建立最小 Creator 记录（仅在 Creator 不存在时）。
 *
 * 真实来源：`data.owner.mid` / `data.owner.name` / `data.owner.face`。
 * followers / following / videoCount / level 在 view 响应里**没有**，
 * 因此保持 `null`（未知）—— 绝不填 0 伪装成「真实是 0」。
 */
async function ensureCreator(owner: { uid: number; name: string; avatar?: string }): Promise<{
  creatorId: string;
  created: boolean;
}> {
  const existing = await creatorRepo.findByUid(owner.uid);
  if (existing) return { creatorId: existing.id, created: false };

  const now = nowIso();
  const candidate: Creator = {
    id: newId('cr'),
    uid: owner.uid,
    name: owner.name,
    ...(owner.avatar ? { avatar: owner.avatar } : {}),
    sign: '',
    level: null,
    followers: null,
    following: null,
    videoCount: null,
    spaceUrl: `https://space.bilibili.com/${owner.uid}/`,
    createdAt: now,
    updatedAt: now,
    source: 'bili-api',
  };
  const parsed = creatorSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`creator normalize failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const res = await creatorRepo.upsertByUid(parsed.data);
  return { creatorId: res.ids[0] ?? parsed.data.id, created: res.added > 0 };
}

/**
 * 确保 `bvid` 在本地有可用的持久化 Video 记录。
 *
 * 性能约定（用户明确要求）：
 *   - 本地已有 → **0 次额外 `/view` 请求**
 *   - 本地首次遇到 → **恰好 1 次 `/view` 请求**
 */
export async function ensureVideoByBvid(
  bvid: string,
  signal?: AbortSignal,
): Promise<BootstrapResult> {
  if (!BVID_RE.test(bvid)) {
    return { ok: false, error: `invalid bvid=${bvid}`, retryable: false };
  }

  // 1) 本地命中：直接返回，绝不重复请求 view
  const local = await videoRepo.findByBvid(bvid);
  if (local) return { ok: true, video: local, fetched: false, createdVideo: false, createdCreator: false };

  // 2) 本地没有 → 请求真实详情
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  let body: unknown;
  try {
    body = await httpGet<unknown>(url, { signal, referrer: BILI_REFERRER.video(bvid) });
  } catch (e) {
    // HTTP / 网络失败：保留真实错误，不伪装成「视频不存在」
    const err = e as HttpError;
    const msg = err instanceof Error ? err.message : String(e);
    logger.warn(`video-bootstrap view failed bvid=${bvid}: ${msg}`);
    return {
      ok: false,
      error: `视频信息获取失败：${msg}`,
      retryable: err?.retryable ?? /timeout|abort|5[0-9]{2}|network/i.test(msg),
      metadataFailed: true,
      ...(typeof err?.status === 'number' ? { httpStatus: err.status } : {}),
    };
  }

  const code = biliCode(body);
  // 3) 业务码非 0：明确「视频信息获取失败」+ 真实 code 说明
  if (code !== 0) {
    const description = code === null ? '响应结构异常（非 B 站 JSON）' : describeViewCode(code);
    const blocked = isBiliBlocked(body);
    logger.warn(`video-bootstrap view code=${String(code)} bvid=${bvid} (${description})`);
    return {
      ok: false,
      error: `视频信息获取失败：${description}`,
      // 风控类业务码视为可重试；「稿件不存在」这类不可重试
      retryable: blocked && code !== -404 && code !== -400 && code !== 62002,
      metadataFailed: true,
      ...(code !== null ? { biliCode: code } : {}),
    };
  }

  // 4) data 缺失 → 失败，不写脏数据
  const data = (body as { data?: unknown }).data;
  if (data === null || data === undefined || typeof data !== 'object') {
    return {
      ok: false,
      error: '视频信息获取失败：响应缺少 data',
      retryable: true,
      metadataFailed: true,
    };
  }

  // 5) 先用占位 creatorId 归一化，拿到 owner 后建立 / 复用 Creator 再定稿
  const pre = normalizeVideoDetail(data, { creatorId: 'pending' });
  if (!pre) {
    return {
      ok: false,
      error: '视频信息获取失败：bvid / aid 缺失或非法',
      retryable: false,
      metadataFailed: true,
    };
  }

  let creatorId = 'pending';
  let createdCreator = false;
  if (pre.owner) {
    try {
      const c = await ensureCreator(pre.owner);
      creatorId = c.creatorId;
      createdCreator = c.created;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `创作者记录建立失败：${msg}`, retryable: false };
    }
  }

  const detail = creatorId === 'pending' ? pre : normalizeVideoDetail(data, { creatorId });
  if (!detail) {
    return {
      ok: false,
      error: '视频信息获取失败：bvid / aid 缺失或非法',
      retryable: false,
      metadataFailed: true,
    };
  }

  // 6) 持久化并取回真正存在于 Dexie 的记录
  const res = await videoRepo.upsertByBvid(detail.video);
  const persisted = await videoRepo.findByBvid(bvid);
  if (!persisted) {
    return { ok: false, error: `视频写入失败：upsert 后仍找不到 bvid=${bvid}`, retryable: false };
  }

  logger.info(
    `video-bootstrap bvid=${bvid} aid=${persisted.aid} fetched=true ` +
      `createdVideo=${res.added > 0} createdCreator=${createdCreator}`,
  );
  return {
    ok: true,
    video: persisted,
    fetched: true,
    createdVideo: res.added > 0,
    createdCreator,
  };
}
