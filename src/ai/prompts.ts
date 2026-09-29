/**
 * AI 分析 prompt 模板（V3.0 重写）。
 *
 * ⚠️ V3.0 修复的核心矛盾（第九节）：
 *   旧 `SCHEMA_NOTE` 声明 `{facts, explanations, evidence, uncertainty, nextResearch}`，
 *   而 `buildCommentAnalyzePrompt` 又额外要求 `support` / `opposition` 带 rpid ——
 *   **同一个 system prompt 里塞了两套互相矛盾的 schema**，模型只能二选一或拼凑，
 *   这就是「AI 返回残缺 JSON」的直接来源之一。
 *
 * 现在：
 *  - 每个领域**只声明一套 schema**，且与 `src/ai/schemas.ts` 的 Zod 定义逐字对应。
 *  - schema 文本由 `describeSchema()` 从字段常量生成，避免 prompt 与 Zod 漂移。
 *  - 评论 prompt 只负责「约束」，不再自行发明字段。
 */

import type { Creator, CreatorSnapshot, Video, VideoSnapshot } from '@models/index';
import type { Comment } from '@models/comment';
import type { SampleComment } from '@services/comment-prep';

/**
 * 评论分析 schema 的 prompt 表述。
 * 字段清单必须与 `commentAIResultSchema` 一致（见 tests/ai/schemas.test.ts 的一致性断言）。
 */
const COMMENT_SCHEMA_TEXT = `
你必须**只**输出一个 JSON 对象，结构如下（不得增删顶层字段名）：
{
  "summary": string,            // 核心结论，一句话；不得引入下方未出现的新事实
  "facts": string[],            // 客观事实：只能来自给定的「客观统计事实」块或样本原文
  "findings": [                 // 你的**解释性**判断
    {
      "type": "theme" | "painpoint" | "emotion" | "controversy" | "behavior",
      "statement": string,      // 一句可独立阅读的判断
      "evidenceRefs": string[]  // 支撑该判断的评论引用（形如 C001）；没有证据就写 []
    }
  ],
  "themes": [                   // 评论中反复出现的主题
    { "name": string, "refs": string[] }   // refs = 对应主题的评论引用（形如 C001）
  ],
  "support": [                  // 支持 / 正面观点
    { "statement": string, "refs": string[] }   // 必须引用样本中真实出现过的 ref
  ],
  "opposition": [               // 质疑 / 反对观点
    { "statement": string, "refs": string[] }   // 必须引用样本中真实出现过的 ref
  ],
  "needs": string[],            // 用户需求（要说明依据了哪些评论样本）
  "questions": string[],        // 高频问题
  "uncertainty": string[],      // 不确定性：必须写明样本量 / 清洗影响 / 抽样偏差 / 数据完整性
  "nextResearch": string[]      // 下一步该采集什么数据（不得写成结论）
}
`;

/** 创作者 / 视频领域 schema 的 prompt 表述（与 generalAIResultSchema 一致） */
const GENERAL_SCHEMA_TEXT = `
你必须**只**输出一个 JSON 对象，结构如下（不得增删顶层字段名）：
{
  "summary": string,
  "facts": string[],          // 客观事实：只能来自给定数据，数字必须能在输入里找到
  "explanations": string[],   // 解释（"可能"/"推测" 前缀），区分相关性 ≠ 因果
  "uncertainty": string[],    // 不确定性与数据缺失说明
  "nextResearch": string[]    // 下一步要查什么数据
}
`;

/** 反幻觉硬约束（所有领域共用） */
const ANTI_FABRICATION = [
  '禁止编造任何输入数据中没有的数字、比例、时间、排名。',
  '拿不到的数据必须写进 uncertainty，不得用 0 或"大约"糊过去。',
  '禁止把词频当成因果：出现次数多 ≠ 是原因。',
];

/** 评论领域专用禁用语（第九节明列） */
const COMMENT_FORBIDDEN = [
  '禁止使用"大多数用户都…""用户普遍…""观众一定…""这个视频导致…"这类无证据的全称判断。',
  '禁止在 support / opposition 中给出不带 refs 引用的观点。',
  '禁止从词频直接推导因果。',
  '禁止在 nextResearch 里写结论——那里只能写"还需要采集什么数据"。',
];

export interface CreatorAnalyzeCtx {
  creator: Creator;
  recentVideos: Video[];
  recentSnapshots: CreatorSnapshot[];
}

export function buildCreatorAnalyzePrompt(ctx: CreatorAnalyzeCtx): { system: string; user: string } {
  const system = [
    '你是一名严谨的 B 站内容数据分析师。只基于用户给定的结构化数据回答。',
    '事实陈述必须来自原始数字；解释必须标注为推测。',
    '解释必须区分相关性 ≠ 因果。',
    ...ANTI_FABRICATION,
    GENERAL_SCHEMA_TEXT,
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
    ...ANTI_FABRICATION,
    GENERAL_SCHEMA_TEXT,
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
      // V3.1.0 · P0-AI 隐私化：视频领域的评论样本同样匿名化（局部 ref，不落库），零 rpid/uname
      commentSample: ctx.comments.slice(0, 100).map((c, i) => ({
        ref: `C${String(i + 1).padStart(3, '0')}`,
        content: c.content.slice(0, 200),
        like: c.like,
      })),
    },
    null,
    2,
  );

  return { system, user };
}

/**
 * V3.1.0 · P0-AI 隐私化：样本条目即 prepare 层的匿名投影（`SampleComment`）。
 * 旧 `CommentPromptSample`（rpidStr/uname）已删除 —— prompt 层不再接触任何身份字段。
 */
export type CommentPromptSample = SampleComment;

export interface CommentAnalyzeCtx {
  /**
   * V3.0.1 · P0-1：**已准备好的受控代表性样本**（`prepareCommentAnalysis().sample`）。
   *
   * ⚠️ 铁律：prompt 构造器**禁止**自己再做 `slice(0, N)`。
   * 采样策略属于 prepare 层（高赞/最新/多样性），prompt 层只负责「把给定的样本如实放进 JSON」。
   * V3.0.0 的缺陷正是这里 `ctx.comments.slice(0, 200)`：它绕过了 prepare 层的 120 条上限，
   * 把最多 200 条评论原文塞进请求体 —— 是 AI 分析变慢与 `REQUEST_FAILED` 的主要来源。
   */
  sample: SampleComment[];
  /** V0.2 · P0-F：客观统计事实（与 AI 推断分离）。由 services/comment-prep 生成。 */
  factsJson?: string;
  /**
   * V0.2 · P0-F：支持 / 反对观点必须引用这些匿名评论 ref（C001 样式），禁止凭空断言。
   * 注意：这是**白名单提示**（提醒模型只能引用样本中出现的 ref），不参与采样。
   */
  requireCitations?: boolean;
  /** 参与统计的评论总数（用于让模型知道「样本是抽样，不是全量」） */
  totalComments?: number;
}

export function buildCommentAnalyzePrompt(ctx: CommentAnalyzeCtx): { system: string; user: string } {
  const requireCitations = ctx.requireCitations !== false;
  // ⚠️ 禁止 slice：样本已在 prepare 层受控。这里只做「如实投影」。
  const sample = ctx.sample;
  const system = [
    '你是一名 B 站评论区研究分析师。你的输出会被程序用严格的结构校验，任何字段缺失或类型错误都会被判为失败。',
    '区分主题 / 高频问题 / 支持观点 / 反对观点 / 用户痛点 / 情绪 / 争议。',
    'facts 段只能复述给定的「客观统计事实」块，禁止编造数字。',
    requireCitations
      ? 'support / opposition / themes / findings 的每一项引用都必须用 "refs" 或 "evidenceRefs" 数组，' +
        '引用值只能是样本里真实出现过的匿名 ref（形如 C001）。'
      : '',
    ctx.factsJson ? '系统会先给出「客观统计事实」块；你输出的 facts 必须与该块一致。' : '',
    '你收到的 sample 是**受控抽样**（不是全部评论）。统计数字以「客观统计事实」块为准；' +
      '你只能对 sample 里的原文做解释，不得假设样本之外的内容。',
    ...COMMENT_FORBIDDEN,
    ...ANTI_FABRICATION,
    // ⚠️ 只声明一套 schema —— 与 src/ai/schemas.ts 逐字对应
    COMMENT_SCHEMA_TEXT,
  ]
    .filter(Boolean)
    .join('\n');

  // 惰性解析 factsJson：容错不抛（脏 facts 不应炸掉整条分析链路）
  let facts: unknown = undefined;
  if (ctx.factsJson) {
    try {
      facts = JSON.parse(ctx.factsJson);
    } catch {
      facts = undefined;
    }
  }

  const user = JSON.stringify(
    {
      // V3.1.0 · P0-AI 隐私化：不再发送 videoId —— 视频身份对模型没有分析价值，只有泄漏风险
      facts,
      // V3.0.1 · P0-1：受控样本（prepare 层已清洗 / 去重 / 截断 / 限量 / 匿名化）
      sampleCount: sample.length,
      totalComments: ctx.totalComments ?? sample.length,
      sample: sample.map((c) => ({
        ref: c.ref,
        content: c.content,
        likes: c.likes,
        replyCount: c.replyCount,
        replyLevel: c.replyLevel,
        selectionReason: c.selectionReason,
        rankInSample: c.rankInSample,
      })),
    },
    null,
    2,
  );

  return { system, user };
}

/**
 * V3.0 · 第七节：自动修复 prompt。
 *
 * 铁律：**只能要求模型「把已有结果改写成指定 schema」，不得重新分析数据、不得新增事实。**
 */
export function buildRepairPrompt(opts: {
  domain: 'comment' | 'creator' | 'video' | 'idea';
  previousRaw: string;
  issues?: string[];
}): { system: string; user: string } {
  const schemaText = opts.domain === 'comment' ? COMMENT_SCHEMA_TEXT : GENERAL_SCHEMA_TEXT;
  const system = [
    '你是一个 JSON 结构修复器。',
    '你的唯一任务：把用户提供的已有结果**改写成**指定 schema。',
    '严禁重新分析数据，严禁添加任何新的观点、数字、事实或评论引用。',
    '只允许：整理字段、把已有内容放进正确字段、补上空数组 []。',
    '如果原结果里缺少某个必填字段且无法从原文得到，就填空字符串或空数组，绝不编造。',
    schemaText,
  ].join('\n');

  const user = JSON.stringify(
    {
      instruction: '把下面已有结果修正为指定 schema，不添加新的事实。',
      validationIssues: opts.issues ?? [],
      previousResult: opts.previousRaw.slice(0, 12_000),
    },
    null,
    2,
  );

  return { system, user };
}

export { COMMENT_SCHEMA_TEXT, GENERAL_SCHEMA_TEXT };
