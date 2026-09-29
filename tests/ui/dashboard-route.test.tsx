/**
 * V3.2.1 · DASHBOARD-001..003：研究台评论研究链接路由回归。
 *
 * 背景（真实缺陷）：DashboardPage 曾把 `CommentAnalysis.videoId`（本地 Dexie
 * Video.id）直接当 bvid 拼 `comment.html?bvid=` 链接 —— 点了必进错误页面。
 * 修复：videoId → 查 Video → 用真实 `video.bvid` 生成 href；Video 缺失时
 * 显示「视频记录缺失」纯文本，绝不生成错误 href。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DashboardPage } from '@ui/pages/dashboard-page';
import { db } from '@db/database';
import { parseBvid } from '@utils/bvid';

const BVID_A = 'BV1AbCdEfGh1';

function videoRow(id: string, bvid: string): Record<string, unknown> {
  return {
    id,
    bvid,
    aid: 1,
    creatorId: 'cr1',
    title: '测试视频',
    description: '',
    pubTime: null,
    duration: null,
    category: '',
    tags: [],
    url: `https://www.bilibili.com/video/${bvid}`,
  };
}

function analysisRow(id: string, videoId: string): Record<string, unknown> {
  return {
    id,
    videoId,
    createdAt: '2026-09-29T10:00:00.000Z',
    model: 'test-model',
    factSummary: '',
    themeResult: [],
    sentimentResult: { positive: 0, neutral: 0, negative: 0 },
    userNeedResult: [],
    questionResult: [],
    supportResult: [],
    oppositionResult: [],
    citedCommentRpids: ['1001'],
    citationMap: {},
    uncertaintyNote: '',
  };
}

async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}

describe('DASHBOARD：评论研究链接路由', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    cleanup();
  });

  it('DASHBOARD-001：videoId → Video 映射 → href 使用真实 bvid', async () => {
    await db.videos.add(videoRow('vid1', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vid1') as never);
    render(<DashboardPage />);
    const link = (await screen.findByRole('link', { name: BVID_A })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`comment.html?bvid=${BVID_A}`);
  });

  it('DASHBOARD-002：Video 记录缺失 → 「视频记录缺失」，不生成错误 href', async () => {
    await db.commentAnalyses.add(analysisRow('ca1', 'vid_missing') as never);
    render(<DashboardPage />);
    expect(await screen.findByText('视频记录缺失')).toBeTruthy();
    // 绝不把本地 id 当 bvid 生成链接
    expect(document.querySelector('a[href*="vid_missing"]')).toBeNull();
  });

  it('DASHBOARD-003：href 的 bvid 可被 CommentPage parseBvid 归一化（跨页路由闭环）', async () => {
    await db.videos.add(videoRow('vid1', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vid1') as never);
    render(<DashboardPage />);
    const link = (await screen.findByRole('link', { name: BVID_A })) as HTMLAnchorElement;
    const href = link.getAttribute('href') ?? '';
    const query = href.split('?')[1] ?? '';
    const raw = new URLSearchParams(query).get('bvid');
    expect(raw).not.toBeNull();
    // CommentPage 侧的统一入口 parseBvid 必须还原出同一 canonical BV 号
    expect(parseBvid(raw)).toBe(BVID_A);
  });
});
