/**
 * 三类 AI 分析 prompt 模板。
 * 全部强制要求输出 facts / explanations / uncertainty 三段。
 */

import type { Creator, CreatorSnapshot, Video, VideoSnapshot } from '@models/index';
import type { Comment } from '@models/comment';

const SCHEMA_NOTE = `
你必须严格输出 JSON，对象结构：
{
  "facts": string[],         // 客观事实（数字、行为、时间），不含解释
  "explanations": string[],  // 可能解释（"可能"/"推测"前缀），含证据字段
  "evidence": { [key: string]: string }, // 每个解释引用的数据点
  "uncertainty": string[],   // 不确定性与数据缺失说明
  "nextResearch": string[]   // 下一步要查什么
}`;

export interface CreatorAnalyzeCtx {
  creator: Creator;
  recentVideos: Video[];
  recentSnapshots: CreatorSnapshot[];
}

export function buildCreatorAnalyzePrompt(ctx: CreatorAnalyzeCtx): { system: string; user: string } {
  const system = [
    '你是一名严谨的 B 站内容数据分析师。只基于用户给定的结构化数据回答，禁止推测未给出的事实。',
    '事实陈述必须来自原始数字。',
    '解释必须区分相关性 ≠ 因果。',
    '必须分三段输出：facts / explanations / uncertainty。',
    SCHEMA_NOTE,
  ].join('\n');

  const user = JSON.stringify(
    {
      creator: {
        uid: ctx.creator.uid,
        name: ctx.creator.name,
        sign: ctx.creator.sign,
        followers: ctx.creator.followers,
        videoCount: ctx.creator.videoCount,
      },
      recentVideos: ctx.recentVideos.slice(0, 20).map((v) => ({
        title: v.title,
        pubTime: v.pubTime,
        // V0.1.1 修复：原代码误把 duration 当成 views，这里改为真实字段 duration。
        // Video 模型本身不存播放数据（views 来自 VideoSnapshot，由 snapshots 段提供）。
        duration: v.duration,
        tags: v.tags,
      })),
      snapshots: ctx.recentSnapshots.slice(-30).map((s) => ({
        ts: s.timestamp,
        followers: s.followers,
        videoCount: s.videoCount,
        totalViews: s.totalViews,
        totalLikes: s.totalLikes,
      })),
    },
    null,
    2,
  );

  return { system, user };
}

export interface VideoAnalyzeCtx {
  video: Video;
  snapshot?: VideoSnapshot;
  recentCreatorAvg?: { medianViews: number; p25: number; p75: number };
  comments: Comment[];
}

export function buildVideoAnalyzePrompt(ctx: VideoAnalyzeCtx): { system: string; user: string } {
  const system = [
    '你是一名 B 站单视频表现分析师。',
    '客观事实 / 推断 / 不确定性 必须分开；不要做爆款百分比预测。',
    '比较必须基于给定基线。',
    SCHEMA_NOTE,
  ].join('\n');

  const user = JSON.stringify(
    {
      video: {
        bvid: ctx.video.bvid,
        title: ctx.video.title,
        pubTime: ctx.video.pubTime,
        tags: ctx.video.tags,
        category: ctx.video.category,
        duration: ctx.video.duration,
      },
      snapshot: ctx.snapshot,
      baseline: ctx.recentCreatorAvg,
      commentSample: ctx.comments.slice(0, 100).map((c) => ({
        uname: c.uname,
        content: c.content.slice(0, 200),
        like: c.like,
      })),
    },
    null,
    2,
  );

  return { system, user };
}

export interface CommentAnalyzeCtx {
  videoId: string;
  comments: Comment[];
  /** V0.2 · P0-F：客观统计事实（与 AI 推断分离）。由 services/comment-prep 生成。 */
  factsJson?: string;
  /** V0.2 · P0-F：支持 / 反对观点必须引用这些原始评论 rpid，禁止凭空断言。 */
  requireCitations?: boolean;
}

export function buildCommentAnalyzePrompt(ctx: CommentAnalyzeCtx): { system: string; user: string } {
  const requireCitations = ctx.requireCitations !== false;
  const system = [
    '你是一名 B 站评论区研究分析师。',
    '区分主题 / 高频问题 / 支持观点 / 反对观点 / 用户痛点 / 情绪 / 争议。',
    '词频 ≠ 因果。',
    '必须分三段输出：facts / explanations / uncertainty。',
    requireCitations
      ? '支持 / 反对观点必须附带原始评论的 rpid（输出字段 support / opposition 的每项都带 "rpid" 引用），禁止凭空断言。'
      : '',
    ctx.factsJson ? '系统会先给出「客观统计事实」块；你的 facts 段必须与该块一致，不得编造数字。' : '',
    SCHEMA_NOTE,
  ]
    .filter(Boolean)
    .join('\n');

  const user = JSON.stringify(
    {
      videoId: ctx.videoId,
      // V0.2 · P0-F：事实块与样本块分开，明确「已算好的数字」vs「待解释的原文」
      facts: ctx.factsJson ? JSON.parse(ctx.factsJson) : undefined,
      sample: ctx.comments.slice(0, 200).map((c) => ({
        rpid: c.rpidStr,
        uname: c.uname,
        content: c.content.slice(0, 300),
        like: c.like,
        level: c.replyLevel,
      })),
    },
    null,
    2,
  );

  return { system, user };
}