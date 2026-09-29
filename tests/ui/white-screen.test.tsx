/**
 * V3.2.1 · WHITE-SCREEN-001..008：评论研究页运行时安全回归。
 *
 * 背景（真实缺陷）：CommentPage.loadStoredReport 曾把 `latest.analysisResult`
 * 盲 cast 成 CommentAIResult —— Dexie 直读不经过 Zod，V3.1.x 旧记录
 * （facts/themes/... 分类式结果）在 `result.narratives.filter()` 处 throw → React 白屏。
 *
 * 本套件对**七种启动异常/数据态**逐一断言「渲染不 throw + 显示明确的降级 UI」：
 *   001 无 bvid            → 空态，不白屏
 *   002 有 bvid 无 Video   → 空态，不白屏
 *   003 有 Video 无分析    → 无报告区，不白屏
 *   004 legacy 结果        → 「该分析来自旧版本」卡片，绝不 throw
 *   005 malformed 结果     → 「该历史 AI 结果已损坏」卡片，绝不 throw
 *   006 V3.2 current 结果  → 正常渲染研究报告
 *   007 刷新（重挂载）     → 报告从库恢复
 *   008 切换 BV            → 旧报告不残留
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CommentPage } from '@ui/pages/comment-page';
import { db } from '@db/database';
import { CURRENT_RESULT, LEGACY_RESULT, MALFORMED_RESULT } from './fixtures/comment-result-fixtures';

const BVID_A = 'BV1AbCdEfGh1'; // BV + 10 位
const BVID_B = 'BV2AbCdEfGh2';

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

/** 直插 Dexie 的 CommentAnalysis 行（绕过 Zod —— 真实库就是历史版本写入的任意形状） */
function analysisRow(
  id: string,
  videoId: string,
  analysisResult: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
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
    citedCommentRpids: [],
    citationMap: {},
    uncertaintyNote: '',
  };
  if (analysisResult !== undefined) row.analysisResult = analysisResult;
  return row;
}

function openPage(bvid?: string): void {
  window.history.replaceState({}, '', bvid ? `/comment.html?bvid=${bvid}` : '/comment.html');
  render(<CommentPage />);
}

async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}

describe('WHITE-SCREEN：评论研究页运行时安全', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    cleanup();
  });

  it('WHITE-SCREEN-001：URL 无 bvid → 空态渲染，不白屏', async () => {
    openPage();
    // 渲染完成（输入区出现）且页面有内容 —— 不是白屏
    expect(await screen.findByText('统计事实')).toBeTruthy();
    expect(document.body.textContent!.length).toBeGreaterThan(0);
    expect(screen.queryByText('AI 分析结果')).toBeNull();
  });

  it('WHITE-SCREEN-002：有 bvid 但库中无 Video → 空态渲染，不白屏', async () => {
    openPage(BVID_A);
    expect(await screen.findByText('统计事实')).toBeTruthy();
    expect(screen.queryByText('AI 分析结果')).toBeNull();
    expect(screen.queryByText('该分析来自旧版本，当前报告结构已经升级。')).toBeNull();
    expect(screen.queryByText('该历史 AI 结果已损坏，无法展示。')).toBeNull();
  });

  it('WHITE-SCREEN-003：有 Video 无分析记录 → 正常空态，无报告区', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    openPage(BVID_A);
    expect(await screen.findByText('统计事实')).toBeTruthy();
    expect(screen.queryByText('AI 分析结果')).toBeNull();
    expect(screen.queryByText('该分析来自旧版本，当前报告结构已经升级。')).toBeNull();
  });

  it('WHITE-SCREEN-004：V3.1.x legacy 结果 → 显式降级卡片，绝不 throw', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vidA', LEGACY_RESULT) as never);
    openPage(BVID_A);
    expect(await screen.findByText('该分析来自旧版本，当前报告结构已经升级。')).toBeTruthy();
    // legacy 绝不渲染成研究报告、绝不显示损坏文案
    expect(screen.queryByText('AI 分析结果')).toBeNull();
    expect(screen.queryByText('该历史 AI 结果已损坏，无法展示。')).toBeNull();
  });

  it('WHITE-SCREEN-005：malformed 结果 → 「已损坏」卡片，绝不 throw', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vidA', MALFORMED_RESULT) as never);
    openPage(BVID_A);
    expect(await screen.findByText('该历史 AI 结果已损坏，无法展示。')).toBeTruthy();
    expect(screen.queryByText('AI 分析结果')).toBeNull();
  });

  it('WHITE-SCREEN-006：V3.2 current 结果 → 正常渲染研究报告', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vidA', CURRENT_RESULT) as never);
    openPage(BVID_A);
    expect(await screen.findByText('AI 分析结果')).toBeTruthy();
    expect(await screen.findByText('评论区围绕视频质量形成两派观点')).toBeTruthy();
    expect(screen.queryByText('该历史 AI 结果已损坏，无法展示。')).toBeNull();
  });

  it('WHITE-SCREEN-007：刷新（重挂载）后报告从库恢复', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vidA', CURRENT_RESULT) as never);
    openPage(BVID_A);
    expect(await screen.findByText('AI 分析结果')).toBeTruthy();
    cleanup();
    // 模拟用户刷新页面（整页重开，同一 URL、同一库）
    openPage(BVID_A);
    expect(await screen.findByText('AI 分析结果')).toBeTruthy();
    expect(await screen.findByText('评论区围绕视频质量形成两派观点')).toBeTruthy();
  });

  it('WHITE-SCREEN-008：切换 BV 后旧报告不残留', async () => {
    await db.videos.add(videoRow('vidA', BVID_A) as never);
    await db.videos.add(videoRow('vidB', BVID_B) as never);
    await db.commentAnalyses.add(analysisRow('ca1', 'vidA', CURRENT_RESULT) as never);
    openPage(BVID_A);
    expect(await screen.findByText('评论区围绕视频质量形成两派观点')).toBeTruthy();
    cleanup();
    // 切到另一个视频（无分析记录）
    openPage(BVID_B);
    expect(await screen.findByText('统计事实')).toBeTruthy();
    expect(screen.queryByText('AI 分析结果')).toBeNull();
    expect(screen.queryByText('评论区围绕视频质量形成两派观点')).toBeNull();
  });
});
