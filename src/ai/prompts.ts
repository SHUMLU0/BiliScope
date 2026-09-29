/**
 * AI 分析 prompt 模板（V3.0 重写；V3.2.0 评论领域升级为 Research Analyst）。
 *
 * ⚠️ V3.0 修复的核心矛盾（第九节）：
 *   旧 `SCHEMA_NOTE` 与 `buildCommentAnalyzePrompt` 塞了两套互相矛盾的 schema，
 *   模型只能二选一或拼凑 —— 这是「AI 返回残缺 JSON」的直接来源之一。
 *
 * 现在：
 *  - 每个领域**只声明一套 schema**，且与 `src/ai/schemas.ts` 的 Zod 定义逐字对应。
 *  - schema 文本由字段常量生成，避免 prompt 与 Zod 漂移。
 *
 * V3.2.0（Comment Research Analyst）：
 *  - 评论 prompt 的任务定义从「整理评论」升级为「重建评论区观点结构并解释其成因与含义」。
 *  - 新增：叙事结构（主/次/反）、用户分群、核心矛盾、可能机制（因果纪律）、
 *    信号/噪声、内容价值、可验证假设（假设→证据→反证→验证方法）。
 *  - 禁止「高级复述」：只改写原文不算分析；质量优先于字段填满率。
 *  - 输出预算：核心报告 1500–3000 tokens；复杂样本 3000–5000 tokens。
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
  "summary": string,            // 核心判断：这批评论整体意味着什么（不是摘要）
  "relevantFacts": string[],    // 相关事实，最多 5 条：只写对研究判断有用的客观事实；
                                // 禁止复述「客观统计事实」块已完整给出的数字（总数 / 时间跨度 / 最高赞 / 样本条数）
  "narratives": [               // 叙事结构，最多 6 条：把评论重建为观点阵营
    {
      "name": string,           // 叙事名称
      "description": string,    // 这个阵营在说什么、如何形成
      "role": "primary" | "secondary" | "counter",   // 主叙事 / 次叙事 / 反叙事
      "refs": string[]          // 引用样本评论（形如 C001）
    }
  ],
  "audienceSegments": [         // 用户群体，最多 5 条：按需求与行为分群，不是按词频分组
    {
      "name": string,
      "need": string,           // 这个群体想要什么
      "behavior": string,       // 他们在评论里实际做了什么
      "refs": string[]
    }
  ],
  "tensions": [                 // 核心矛盾，最多 5 条：真实存在的立场冲突
    {
      "statement": string,      // 矛盾是什么
      "sideA": string,          // A 方观点（需有 refs 支撑）
      "sideB": string,          // B 方观点（需有 refs 支撑）
      "refs": string[]
    }
  ],
  "mechanisms": [               // 为什么会产生这种讨论，最多 5 条：可能机制（因果纪律：只能假设）
    {
      "hypothesis": string,     // 机制假设（用「可能」措辞）
      "explanation": string,    // 解释该机制如何把评论内容与讨论形态联系起来
      "evidenceRefs": string[], // 证据评论引用；没有就 []
      "confidence": "low" | "medium" | "high"
    }
  ],
  "signalVsNoise": [            // 信号 / 噪声，最多 8 条：区分有信息量的评论与干扰项
    {
      "type": "signal" | "noise",
      "statement": string,      // 该条评论（类）说了什么
      "reason": string,         // 为什么是信号 / 为什么是噪声（必填）
      "refs": string[]
    }
  ],
  "contentImplications": [      // 对内容研究意味着什么，最多 5 条
    {
      "insight": string,        // 洞察
      "basisRefs": string[],    // 依据的评论引用
      "implication": string     // 对后续内容 / 研究的可操作含义
    }
  ],
  "claims": [                   // 可核查论断，最多 8 条：评论中可被事实检验的说法
    { "statement": string, "refs": string[], "confidence": "low" | "medium" | "high" }
  ],
  "hypothesesToTest": [         // 可验证假设，最多 5 条：假设 → 支持 → 反证 → 缺什么 → 怎么验证
    {
      "hypothesis": string,
      "evidenceForRefs": string[],
      "evidenceAgainstRefs": string[],
      "missingEvidence": string[],   // 缺失的证据
      "testMethod": string           // 用什么数据 / 方法验证（必填）
    }
  ],
  "needs": string[],            // 用户需求（要说明依据了哪些评论样本）
  "questions": string[],        // 高频问题
  "uncertainty": string[],      // 不确定性：必须写明样本量 / 清洗影响 / 抽样偏差 / 数据完整性
  "nextResearch": string[]      // 下一步该采集什么数据（不得写成结论）
}

质量纪律：宁可少而准，不要凑数——证据不足的数组留空 [] 是合法输出；
绝不为了填字段而输出空泛的复述。七个研究判断字段（narratives / tensions / mechanisms /
signalVsNoise / contentImplications / claims / hypothesesToTest）至少一个必须非空。
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

/** 评论领域专用禁用语（V3.2.0 Research Analyst 纪律） */
const COMMENT_FORBIDDEN = [
  '禁止使用"大多数用户都…""用户普遍…""观众一定…""这个视频导致…"这类无证据的全称判断。',
  'narratives / tensions / claims / mechanisms / signalVsNoise / contentImplications / hypothesesToTest 的每一项都应引用样本中真实出现过的匿名 ref；确实无法引用时留空数组并在 uncertainty 说明，绝不凭空断言。',
  '禁止从词频直接推导因果；禁止把"相关"写成"因果"（当前数据没有实验设计证明因果）。',
  '禁止在 nextResearch 里写结论——那里只能写"还需要采集什么数据"。',
  '禁止"高级复述"：仅仅改写或归纳原始评论（如"很多人认为X"）不算分析；每个判断必须给出判断、解释关系、提供 refs、标注置信度。',
  '禁止在 relevantFacts 里复述输入统计块已完整给出的数字（总评论数 / 时间跨度 / 最高赞 / 样本条数等 UI 已展示的内容）。',
  '禁止为了填满字段而硬凑内容：没有足够证据时数组必须为空，质量优先于字段填满率。',
];

/** V3.2.0 · Research Analyst 任务定义（第一原则 + 十二问） */
const RESEARCH_PRINCIPLES = [
  '你是一名 B 站评论区研究分析师（Comment Research Analyst），不是评论摘要器。',
  '【第一原则】不要把任务理解成"把评论分类"。你的任务是：从评论样本中重建评论区的观点结构，' +
    '并解释为什么这些观点会形成、彼此冲突、产生互动，以及这些讨论对内容研究意味着什么。',
  '你必须尝试回答：评论区真正围绕什么问题；表面主题下面的核心叙事是什么；哪些观点属于主叙事、' +
    '哪些属于反叙事；用户之间真正冲突在哪里；哪些评论只是情绪/玩梗、哪些包含真正的信息信号；' +
    '有哪些可能的互动驱动机制；不同用户群体在关注什么；这条内容真正满足了什么需求；' +
    '哪些判断目前证据不足；最值得验证的假设是什么。',
  '叙事结构：必须尝试区分主叙事（primary）、次叙事（secondary）与反叙事（counter），并用样本 refs 支撑。',
  '用户分群：尝试区分情绪参与者 / 反叙事参与者 / 信息求证者 / 实用信息需求者 / 比较型用户 / 玩梗用户；' +
    '样本无法可靠区分某群体时如实写明，禁止强行编造。',
  '信号/噪声：噪声 = 只承担情绪表态、不提供新事实或逻辑的评论；信号 = 提出新事实、新逻辑或真问题的评论。每条判定必须给 reason。',
  '机制分析：只能写"可能机制"，用置信度标注不确定性；禁止把机制写成确定因果。',
  '可验证假设：hypothesesToTest 不是"下一步继续采集评论"，而是假设 → 支持证据 → 反证 → 目前缺失的证据 → 具体验证方法。',
  '输出预算：常规样本核心报告约 1500–3000 tokens；约 200 条的复杂样本约 3000–5000 tokens。不要为填字段强行突破。',
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
    ...RESEARCH_PRINCIPLES,
    '你收到的 sample 是**受控抽样**（不是全部评论）。统计数字以「客观统计事实」块为准；' +
      '你只能对 sample 里的原文做解释，不得假设样本之外的内容。',
    'relevantFacts 只能来自给定的「客观统计事实」块或样本原文，禁止编造数字；且不得复述该块已完整给出的汇总数字。',
    requireCitations
      ? '所有判断字段的每一项引用都必须用 refs / evidenceRefs / basisRefs / evidenceForRefs / evidenceAgainstRefs 数组，' +
        '引用值只能是样本里真实出现过的匿名 ref（形如 C001）。'
      : '',
    ctx.factsJson ? '系统会先给出「客观统计事实」块；relevantFacts 必须与该块一致。' : '',
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
