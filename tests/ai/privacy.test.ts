/**
 * V3.1.0 · P0-AI 隐私化验收（AI-PRIVACY-001..004）。
 *
 * 铁律（用户规格第 1 节）：AI 不得看到 videoId / rpid / mid / midStr / uname / uid。
 * AI 只见匿名引用 `{ref:"C001", content, likes, replyCount, replyLevel, selectionReason, rankInSample}`；
 * ref → 真实 rpid 的映射（citationMap）**只存在于本地 CommentAnalysis**，绝不发送 Provider。
 *
 * 「真实 ID 留在本地，所有引用可回溯，所有 AI 结果可审计。」
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, db } from '@db/database';
import { prepareCommentAnalysis, serializeCommentFacts } from '@services/comment-prep';
import { buildCommentAnalyzePrompt } from '@ai/prompts';
import { orchestrate } from '@ai/orchestrator';
import type { Comment } from '@models/comment';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── 故意「可搜索」的真实身份值：任何一处泄漏都会让断言红 ──
const REAL_RPID = '1701234567890123456';
const REAL_RPID_2 = '1709988776655443322';
const REAL_UNAME = '张三丰测试用户';
const REAL_MID = '9988776655';
const REAL_VIDEO_ID = 'BV1AbCdEfGhi';

const iso = new Date(0).toISOString();

const cm = (over: Partial<Comment> & { rpidStr: string; content: string }): Comment => ({
  id: `c${over.rpidStr}`,
  videoId: REAL_VIDEO_ID,
  rpid: Number(over.rpidStr) || 0,
  mid: Number(REAL_MID),
  midStr: REAL_MID,
  rootRpid: 0,
  parentRpid: 0,
  dialog: 0,
  replyLevel: 1,
  rootRpidStr: over.rpidStr,
  parentRpidStr: '',
  dialogStr: over.rpidStr,
  like: 0,
  replyCount: 0,
  ctime: 1000,
  uname: REAL_UNAME,
  level: 0,
  createdAt: iso,
  updatedAt: iso,
  source: 'wbi-main',
  ...over,
});

function makeComments(): Comment[] {
  return [
    cm({ rpidStr: REAL_RPID, content: '画质真好，希望下期讲讲镜头参数选择', like: 42, replyCount: 3 }),
    cm({ rpidStr: REAL_RPID_2, content: '更新太慢了，等得花都谢了，求更新频率提升', like: 7, replyCount: 1 }),
  ];
}

beforeEach(async () => {
  localStorage.clear();
  await clearAll();
});

// ─────────────────────────────────────────────────────────── AI-PRIVACY-001
describe('AI-PRIVACY-001 · prompt 零身份泄漏', () => {
  it('system + user 不含真实 rpid / uname / videoId / mid；样本条目只带匿名 ref', () => {
    const prep = prepareCommentAnalysis(makeComments());
    const { system, user } = buildCommentAnalyzePrompt({
      sample: prep.sample,
      totalComments: prep.total,
      factsJson: serializeCommentFacts(prep),
    });
    const all = `${system}\n${user}`;
    expect(all).not.toContain(REAL_RPID);
    expect(all).not.toContain(REAL_RPID_2);
    expect(all).not.toContain(REAL_UNAME);
    expect(all).not.toContain(REAL_VIDEO_ID);
    expect(all).not.toContain(REAL_MID);

    const parsed = JSON.parse(user) as {
      videoId?: unknown;
      sample: Array<Record<string, unknown>>;
    };
    // user JSON 顶层不得再有 videoId 键
    expect('videoId' in parsed).toBe(false);
    // 样本条目不得携带身份键
    for (const s of parsed.sample) {
      expect('rpid' in s).toBe(false);
      expect('rpidStr' in s).toBe(false);
      expect('uname' in s).toBe(false);
      expect('mid' in s).toBe(false);
    }
    // 匿名引用必须存在且格式为 C001 起始
    expect(all).toContain('C001');
    expect(parsed.sample.map((s) => s.ref)).toContain('C001');
  });
});

// ─────────────────────────────────────────────────────────── AI-PRIVACY-004
describe('AI-PRIVACY-004 · facts + sample 双块零泄漏', () => {
  it('serializeCommentFacts 的 topComments 用 {ref,likes,excerpt}，全文无 rpid/uname', () => {
    const prep = prepareCommentAnalysis(makeComments());
    const factsJson = serializeCommentFacts(prep);
    expect(factsJson).not.toContain(REAL_RPID);
    expect(factsJson).not.toContain(REAL_RPID_2);
    expect(factsJson).not.toContain(REAL_UNAME);
    expect(factsJson).not.toContain(REAL_MID);

    const facts = JSON.parse(factsJson) as {
      topComments: Array<Record<string, unknown>>;
    };
    expect(facts.topComments.length).toBeGreaterThan(0);
    for (const t of facts.topComments) {
      expect('rpid' in t).toBe(false);
      expect('uname' in t).toBe(false);
      expect('ref' in t).toBe(true);
      expect('likes' in t).toBe(true);
      expect('excerpt' in t).toBe(true);
    }
  });

  it('citationMap 在 prepare 层产出：ref → 真实 rpidStr，映射完整', () => {
    const prep = prepareCommentAnalysis(makeComments());
    expect(prep.citationMap['C001']).toBe(REAL_RPID);
    expect(prep.citationMap['C002']).toBe(REAL_RPID_2);
    // 映射是本地对象，绝不混入 sample / facts
    expect(JSON.stringify(prep.sample)).not.toContain(REAL_RPID);
  });
});

// ─────────────────────────────────────────────────────────── AI-PRIVACY-002 / 003
const KEY = 'biliscope.ai.providers.v1';
function saveCfg(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      activeProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          name: 'openai-compatible',
          baseUrl: 'https://openai.example/v1',
          apiKey: 'sk-test',
          model: 'gpt-x',
        },
      },
    }),
  );
}

/** AI 返回的匿名引用结果（ref 语义：refs / evidenceRefs） */
const AI_RESULT_WITH_REFS = JSON.stringify({
  summary: '评论区以画质与更新频率讨论为主',
  facts: ['样本 2 条'],
  findings: [{ type: 'theme', statement: '画质被讨论', evidenceRefs: ['C001'] }],
  themes: [{ name: '画质', refs: ['C001'] }],
  support: [{ statement: '认可画质', refs: ['C001'] }],
  opposition: [{ statement: '更新慢', refs: ['C002'] }],
  needs: ['提高更新频率'],
  questions: ['下期何时出'],
  uncertainty: ['样本量小'],
  nextResearch: ['补充二级回复'],
});

function mockFetchOnce(): void {
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { temperature?: number };
    if (body.temperature === 0) {
      // 修复请求：返回相同内容
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-p',
        model: 'gpt-x',
        choices: [{ finish_reason: 'stop', message: { content: AI_RESULT_WITH_REFS } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('AI-PRIVACY-002 · C001 → 真实 rpid 本地回溯', () => {
  it('orchestrate 落库的 citedCommentRpids 是真实 rpid，citationMap 一并落库', async () => {
    saveCfg();
    mockFetchOnce();
    const prep = prepareCommentAnalysis(makeComments());
    const r = await orchestrate({
      domain: 'comment',
      targetId: REAL_VIDEO_ID,
      systemPrompt: 'sys',
      userPrompt: 'user',
      knownRefs: Object.keys(prep.citationMap),
      citationMap: prep.citationMap,
      requestStrategy: 'single',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 落库的产品结果：引用审计回真实 rpid（本地可回溯）
    const stored = await db.commentAnalyses.get(r.domainRecordId!);
    expect(stored).toBeTruthy();
    expect(stored!.citedCommentRpids).toContain(REAL_RPID);
    expect(stored!.citedCommentRpids).toContain(REAL_RPID_2);
    // citationMap 必须随产品结果落库
    expect(stored!.citationMap['C001']).toBe(REAL_RPID);
    expect(stored!.citationMap['C002']).toBe(REAL_RPID_2);
    // 产品结构（analysisResult）保持 ref 语义（AI 结构原样）
    expect(stored!.analysisResult?.support[0]?.refs).toEqual(['C001']);
  });
});

describe('AI-PRIVACY-003 · 历史 reload 后 citationMap 仍可用', () => {
  it('重新从 Dexie 读取后，ref → rpid 映射与 UI 定位链路完整', async () => {
    saveCfg();
    mockFetchOnce();
    const prep = prepareCommentAnalysis(makeComments());
    const r = await orchestrate({
      domain: 'comment',
      targetId: REAL_VIDEO_ID,
      systemPrompt: 'sys',
      userPrompt: 'user',
      knownRefs: Object.keys(prep.citationMap),
      citationMap: prep.citationMap,
      requestStrategy: 'single',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 模拟「页面关闭后重开」：全新读取（不经内存对象）
    const reloaded = await db.commentAnalyses.toArray();
    const row = reloaded.find((x) => x.id === r.domainRecordId);
    expect(row).toBeTruthy();
    const map = row!.citationMap ?? {};
    // ref → 真实 rpid 的回溯能力必须在 reload 后仍然完整
    expect(map['C001']).toBe(REAL_RPID);
    expect(map['C002']).toBe(REAL_RPID_2);
    // analysisResult 里的 refs 全部能在 citationMap 中解析
    for (const ref of row!.analysisResult?.support[0]?.refs ?? []) {
      expect(map[ref]).toBeTruthy();
    }
  });
});

// ══════════════════════════════════════════════════════════ V3.1.1 · PRIVACY-001..004
/**
 * V3.1.1 补充验收：Probe（旁路诊断）与 Main（正式分析）**双通道**零身份。
 * Probe 请求体是独立的极轻对象（buildProbeRequest），天然不含评论数据；
 * 本组测试把这条不变量钉死 —— 任何身份字段进入任一通道都会让断言红。
 */
describe('V3.1.1 · PRIVACY-001..004 · Probe/Main 双通道零身份', () => {
  interface CapturedBody {
    messages?: Array<{ role: string; content: string }>;
    max_tokens?: number;
  }

  function makeDualChannelMock(o: {
    probe: 'ok' | 'reject401';
    mainDelayMs?: number;
  }): { captured: { probe?: CapturedBody; main?: CapturedBody } } {
    const captured: { probe?: CapturedBody; main?: CapturedBody } = {};
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as CapturedBody;
      const isProbe =
        body.max_tokens === 32 && body.messages?.some((m) => m.role === 'user' && m.content === 'probe');
      if (isProbe) {
        captured.probe = body;
        if (o.probe === 'reject401') {
          await new Promise((res) => setTimeout(res, 10));
          throw new Error('HTTP 401 Unauthorized（认证失败）');
        }
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      captured.main = body;
      await new Promise((res) => setTimeout(res, o.mainDelayMs ?? 0));
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: AI_RESULT_WITH_REFS } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { captured };
  }

  async function runOrchestrate(): Promise<void> {
    const prep = prepareCommentAnalysis(makeComments());
    // 用**真实构造的 prompt**（不是占位字符串）—— Main 请求体断言才有意义
    const { system, user } = buildCommentAnalyzePrompt({
      sample: prep.sample,
      totalComments: prep.total,
      factsJson: serializeCommentFacts(prep),
      requireCitations: true,
    });
    await orchestrate({
      domain: 'comment',
      targetId: REAL_VIDEO_ID,
      systemPrompt: system,
      userPrompt: user,
      knownRefs: Object.keys(prep.citationMap),
      citationMap: prep.citationMap,
    });
  }

  it('PRIVACY-001: Probe 请求体零身份、零评论数据（独立极轻对象，只有 probe 探针语料）', async () => {
    saveCfg();
    await clearAll();
    const { captured } = makeDualChannelMock({ probe: 'ok', mainDelayMs: 50 });
    await runOrchestrate();
    expect(captured.probe).toBeTruthy();
    const s = JSON.stringify(captured.probe);
    // 四类真实身份值全部不得出现
    expect(s).not.toContain(REAL_RPID);
    expect(s).not.toContain(REAL_UNAME);
    expect(s).not.toContain(REAL_VIDEO_ID);
    expect(s).not.toContain(REAL_MID);
    // 探针绝不携带评论正文（用正文中独有的词做金丝雀）
    expect(s).not.toContain('画质');
    // 探针语料就是那一句固定探针 prompt
    expect(s).toContain('probe');
  });

  it('PRIVACY-002: Main 请求体零身份；匿名 ref（C001）在场', async () => {
    saveCfg();
    await clearAll();
    const { captured } = makeDualChannelMock({ probe: 'ok', mainDelayMs: 50 });
    await runOrchestrate();
    expect(captured.main).toBeTruthy();
    const s = JSON.stringify(captured.main);
    expect(s).not.toContain(REAL_RPID);
    expect(s).not.toContain(REAL_UNAME);
    expect(s).not.toContain(REAL_VIDEO_ID);
    expect(s).not.toContain(REAL_MID);
    // 匿名引用在场（模型只见 ref）
    expect(s).toContain('C001');
  });

  it('PRIVACY-003: Probe 失败审计行 —— 发给 Provider 的语料与诊断 meta 零身份', async () => {
    saveCfg();
    await clearAll();
    // probe 10ms 即 401（失败 → 留独立审计行）；main 100ms 后成功
    makeDualChannelMock({ probe: 'reject401', mainDelayMs: 100 });
    await runOrchestrate();
    const audits = await db.aiAnalyses.toArray();
    const probeRows = audits.filter((a) => a.requestType === 'probe');
    expect(probeRows).toHaveLength(1);
    const row = probeRows[0]!;
    // 「零身份」约束的是**发给 Provider 的内容**（probe 语料）与诊断 meta；
    // 审计行的 targetId 是本地归档键（与产品结果同 key），不属于外发通道。
    const sent = `${row.systemPrompt} ${row.userPrompt}`;
    const metaStr = JSON.stringify((row.parsedResult as Record<string, unknown>).__meta ?? {});
    for (const s of [sent, metaStr]) {
      expect(s).not.toContain(REAL_RPID);
      expect(s).not.toContain(REAL_UNAME);
      expect(s).not.toContain(REAL_VIDEO_ID);
      expect(s).not.toContain(REAL_MID);
    }
    // 失败原因如实记录
    expect(metaStr).toContain('401');
  });

  it('PRIVACY-004: 成功审计 meta（probe 三态 + 请求指纹）零身份', async () => {
    saveCfg();
    await clearAll();
    makeDualChannelMock({ probe: 'ok', mainDelayMs: 50 });
    await runOrchestrate();
    const audits = await db.aiAnalyses.toArray();
    const analysisRow = audits.find((a) => a.requestType !== 'probe');
    expect(analysisRow).toBeTruthy();
    const meta = ((analysisRow!.parsedResult as Record<string, unknown>).__meta ?? {}) as Record<
      string,
      unknown
    >;
    expect(meta.status).toBe('SUCCESS');
    expect(meta.probe).toBeTruthy();
    expect(meta.requestFingerprintBefore).toBeTruthy();
    const s = JSON.stringify(meta);
    expect(s).not.toContain(REAL_RPID);
    expect(s).not.toContain(REAL_UNAME);
    expect(s).not.toContain(REAL_VIDEO_ID);
    expect(s).not.toContain(REAL_MID);
  });
});
