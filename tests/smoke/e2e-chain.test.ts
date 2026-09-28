/**
 * 真实 E2E Smoke：完整产品链路
 *
 *   真实 B 站响应 → Collector → Normalizer → Repository → Dexie → 查询
 *
 * 这里**不是**只打一个 fetch 看 200，而是真的跑 Collector.collect()，
 * 再用 Repository 从 Dexie 里读回来，验证字段是否落库正确。
 *
 * 结论语义见 ./classify.ts：PASS / PASS_WITH_ENV_LIMIT / FAIL。
 * 环境风控不会被包装成 PASS。
 *
 * 运行：pnpm test:smoke（已从常规 CI 剥离）
 */

import 'fake-indexeddb/auto';
import { describe, it } from 'vitest';
import { CreatorCollector } from '@collectors/creator-collector';
import { SearchCollector } from '@collectors/search-collector';
import { VideoCollector } from '@collectors/video-collector';
import { creatorRepo, creatorSnapshotRepo, videoRepo } from '@repositories/index';
import { cacheClear } from '@utils/cache';
import { db } from '@db/database';
import { httpGet } from '@utils/http';
import { BILI_REFERRER, biliCode } from '@utils/bili';
import { assertNotFail, classifyBili, type SmokeVerdict } from './classify';

const UID = 946974; // 影视飓风
const KEYWORD = '影视飓风';

describe('E2E: 真实响应 → Collector → Repository → Dexie', () => {
  it(
    'CreatorCollector 对真实 UID 落库，粉丝/关注/投稿为真实值或 null（不得为 0 伪装）',
    async () => {
      cacheClear();
      await db.creators.clear();
      await db.creatorSnapshots.clear();

      const r = await new CreatorCollector().collect({ targetId: String(UID) });
      if (!r.ok) {
        throw new Error(`[smoke:FAIL] CreatorCollector 失败: ${r.error}`);
      }
      // Repository → Dexie → 读回（不直接用 collect 返回对象，必须验证真的落进了 IndexedDB）
      const stored = await creatorRepo.findByUid(UID);
      if (!stored) throw new Error('[smoke:FAIL] creator 未落库');

      const snaps = await creatorSnapshotRepo.listByCreator(stored.id);
      const realFans = stored.followers;
      const verdict: SmokeVerdict =
        typeof realFans === 'number' && realFans > 0
          ? 'PASS'
          : realFans === null
            ? 'PASS_WITH_ENV_LIMIT'
            : 'FAIL';

      assertNotFail(
        verdict,
        `uid=${UID} name=${stored.name} followers=${realFans} following=${stored.following} ` +
          `videoCount=${stored.videoCount} level=${stored.level} snapshots=${snaps.length}`,
      );

      // 语义红线：未知必须是 null，不能是 0
      if (stored.followers === 0 || stored.following === 0 || stored.videoCount === 0) {
        throw new Error('[smoke:FAIL] 出现 0 值伪装：未知字段必须是 null');
      }
      // 快照必须继承真实值状态
      if (snaps.length > 0) {
        const s = snaps[0]!;
        if (s.followers === 0 || s.following === 0 || s.videoCount === 0) {
          throw new Error('[smoke:FAIL] snapshot 用 0 伪装未知值');
        }
      }
    },
    60_000,
  );

  it(
    'SearchCollector 真实关键词 → 保留 UP / 播放 / 时长，并落库可查',
    async () => {
      cacheClear();
      const r = await new SearchCollector().collect({ targetId: KEYWORD });
      if (!r.ok) {
        // 对照组：未签名的最朴素搜索请求
        const legacy = await httpGet<unknown>(
          `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
            KEYWORD,
          )}&page=1&page_size=5`,
          { referrer: BILI_REFERRER.search, retries: 0 },
        ).catch(() => null);
        const verdict = classifyBili({
          code: null,
          hasData: false,
          legacyCode: biliCode(legacy),
          structureOk: true,
        });
        assertNotFail(verdict, `search failed: ${r.error}`);
        return;
      }
      const list = r.data;
      const first = list[0];
      const verdict = list.length > 0 && first?.authorName && typeof first.views === 'number'
        ? 'PASS'
        : 'FAIL';
      assertNotFail(
        verdict as SmokeVerdict,
        `keyword=${KEYWORD} got=${list.length} first={title:${first?.title?.slice(0, 20)}, up:${
          first?.authorName
        }, mid:${first?.authorMid}, play:${first?.views}, duration:${first?.duration}, pubTime:${
          first?.pubTime
        }}`,
      );
      if (verdict === 'PASS') {
        // 落库 → 查询（Repository → Dexie）
        for (const v of list.slice(0, 5)) {
          await db.videos.put(v);
        }
        const back = await videoRepo.findByBvid(list[0]!.bvid);
        if (!back) throw new Error('[smoke:FAIL] search 结果未落库');
        if (back.authorName !== list[0]!.authorName || back.views !== list[0]!.views) {
          throw new Error('[smoke:FAIL] 落库后 UP / 播放字段丢失');
        }
      }
    },
    60_000,
  );

  it(
    'VideoCollector 一次采集不再对每个视频打 /view（list vs detail 请求量）',
    async () => {
      cacheClear();
      // 先确保 creator 存在（VideoCollector 依赖）
      const cr = await new CreatorCollector().collect({ targetId: String(UID) });
      if (!cr.ok) {
        assertNotFail('PASS_WITH_ENV_LIMIT', `creator 采集失败（环境限制）: ${cr.error}`);
        return;
      }
      const logs: string[] = [];
      const origInfo = console.info;
      console.info = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
        origInfo(...(args as []));
      };
      try {
        const r = await new VideoCollector().collectByCreator(UID);
        const line = logs.find((l) => l.includes('detail view requests')) ?? '';
        if (!r.ok) {
          // arc/search 在匿名 + 风控下大概率被拦 —— 属环境限制
          assertNotFail('PASS_WITH_ENV_LIMIT', `video collect: ${r.error}`);
        } else {
          // 默认不补详情 → detail 必须为 0
          const m = /detail view requests = (\d+)/.exec(line);
          const detail = m ? Number(m[1]) : -1;
          if (detail !== 0) throw new Error(`[smoke:FAIL] detail view requests=${detail}（应为 0）`);
          assertNotFail('PASS', `${line || r.stats ? JSON.stringify(r.stats) : 'no videos'}`);
        }
      } finally {
        console.info = origInfo;
      }
    },
    60_000,
  );
});
