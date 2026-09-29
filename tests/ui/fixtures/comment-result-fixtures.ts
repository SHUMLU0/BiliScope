/**
 * V3.2.1 · 共享测试 fixture：评论 AI 结果的三种历史形态。
 * 被 tests/utils/bvid.test.ts 与 tests/ui/white-screen.test.tsx 共用，
 * 保证「三态判定」与「页面渲染」测试看到的是同一组数据。
 */

/** V3.2 研究契约的最小合规 fixture（summary 非空 + 研究判断字段非空，superRefine 可过） */
export const CURRENT_RESULT = {
  summary: '评论区围绕视频质量形成两派观点',
  relevantFacts: ['高赞评论多为对内容质量的讨论'],
  narratives: [
    { name: '质量认可', description: '认为内容质量高', role: 'primary', refs: ['C001'] },
    { name: '质量质疑', description: '认为内容注水', role: 'counter', refs: ['C002'] },
  ],
  audienceSegments: [],
  tensions: [{ statement: '质量认可 vs 质量质疑', sideA: '质量高', sideB: '内容注水', refs: [] }],
  mechanisms: [],
  signalVsNoise: [{ type: 'signal', statement: '有评论给出具体论据', reason: '提供了新事实', refs: ['C001'] }],
  contentImplications: [],
  claims: [{ statement: '多数评论认可内容质量', refs: ['C001'], confidence: 'medium' }],
  needs: [],
  questions: [],
  uncertainty: ['样本仅 2 条，代表性有限'],
  hypothesesToTest: [
    {
      hypothesis: '长评论更倾向认可质量',
      evidenceForRefs: ['C001'],
      evidenceAgainstRefs: [],
      missingEvidence: ['需要更大样本'],
      testMethod: '扩样后按评论长度分组对比',
    },
  ],
  nextResearch: ['扩样采集 200 条评论'],
};

/** V3.1.x 分类式结果（legacy 特征：facts/themes/support/opposition/findings） */
export const LEGACY_RESULT = {
  facts: ['评论区讨论质量'],
  themes: [{ name: '质量', refs: ['C001'] }],
  support: [{ statement: '多数认可', refs: [] }],
  opposition: [{ statement: '少数质疑', refs: [] }],
  findings: [{ type: 'theme', statement: '两派并存', evidenceRefs: [] }],
};

/** 损坏 / 无关数据（既非 V3.2 骨架也非 legacy 特征） */
export const MALFORMED_RESULT = { foo: 'bar', n: 1 };
