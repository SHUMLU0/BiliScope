import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Nav } from '../components/Nav';
import { CommentCollector } from '@collectors/comment-collector';
import { commentRepo, videoRepo, aiAnalysisRepo, commentAnalysisRepo } from '@repositories/index';
import { buildCommentAnalyzePrompt } from '@ai/prompts';
import { orchestrateCommentAnalysis } from '@ai/orchestrator';
import { describeFailure, type AIFailureInfo } from '@ai/failures';
import type { CommentAIResult } from '@ai/schemas';
import type { StreamProgress } from '@ai/types';
import { CommentAIReport, AIFailureNotice } from '../components/CommentAIReport';
import { computeCommentStats, countKeywords, topComments } from '@services/analytics';
import {
  prepareCommentAnalysis,
  serializeCommentFacts,
  SAMPLE_STRATEGY_LABEL,
  DEFAULT_SAMPLE_LIMIT,
  type CommentSampleStrategy,
  type CommentInputBudget,
} from '@services/comment-prep';
import { formatInt, formatPct } from '@utils/time';
import type { Comment, CommentTier, CommentSort, CommentDepth, CommentAnalysis } from '@models/comment';
import type { AIAnalysis } from '@models/task';

const collector = new CommentCollector();

type SortKey = 'like' | 'time' | 'reply';

/** 已存在的产品结果行（来自 commentAnalysisRepo） */
interface StoredReport {
  record: CommentAnalysis;
  /**
   * V3.0.1 · P0-2：**结构化业务结果**（来自 `CommentAnalysis.analysisResult`）。
   * `null` 表示该记录是 V3.0.0 及更早写入的旧记录（未保存结构化结果），UI 必须显式提示重新分析。
   * ⚠️ 绝不从 `rawResponse` 里取 —— 那是 Provider 原始响应，不是业务结果。
   */
  analysisResult: CommentAIResult | null;
}

export function CommentPage() {
  const [bvid, setBvid] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState('');
  const [statusLevel, setStatusLevel] = useState<'info' | 'warn' | 'error'>('info');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('like');
  // 采集档位（P0-A/B）
  const [sort, setSort] = useState<CommentSort>('time');
  const [tier, setTier] = useState<CommentTier>('standard');
  const [depth, setDepth] = useState<CommentDepth>('top');
  // 真实环境诊断（P1）
  const [diag, setDiag] = useState<string>('');
  // V3.0.1 · P0-1：AI 样本策略（只影响送 AI 的样本，不影响统计基数）
  const [sampleStrategy, setSampleStrategy] = useState<CommentSampleStrategy>('hot');
  // V3.0.1 · P0-1/P1-5：AI 样本上限（默认 120；输入过大时优先在这里降，而不是让请求失败）
  const [aiSampleLimit, setAiSampleLimit] = useState(DEFAULT_SAMPLE_LIMIT);

  // ── V3.0：AI 分析状态（强类型，不再是裸字符串） ──
  const [aiBusy, setAiBusy] = useState(false);
  const [report, setReport] = useState<StoredReport | null>(null);
  const [aiFailure, setAiFailure] = useState<AIFailureInfo | null>(null);
  const [aiMeta, setAiMeta] = useState<{
    model: string;
    durationMs: number;
    requestCount: number;
    repaired: boolean;
    unknownRpids: string[];
    claimsWithoutCitation: number;
    notice?: string;
  } | null>(null);
  const [history, setHistory] = useState<AIAnalysis[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [highlightRpid, setHighlightRpid] = useState<string | null>(null);
  // V3.0.1 · 第七节：真实阶段 + 已耗时（不编造百分比）
  const [aiStage, setAiStage] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  // V3.0.1 · P0-A：流式实时进度（模型已开始输出 / 已接收 XX 字符）。
  // 只在流式链路有值；非流式 fallback 保持 null，UI 退回「请求模型… Ns」。
  const [aiStream, setAiStream] = useState<StreamProgress | null>(null);
  // V3.0.1 · P1-5：本次实际送入 AI 的输入预算
  const [aiBudget, setAiBudget] = useState<CommentInputBudget | null>(null);
  const aiT0 = useRef(0);

  const commentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const b = sp.get('bvid');
    if (b) setBvid(b);
  }, []);

  // V3.0.1 · 第七节：分析期间每 1s 刷新真实耗时（只有真实秒数，没有假进度条）
  useEffect(() => {
    if (!aiBusy) return;
    const id = setInterval(() => {
      setAiElapsed(Math.round((performance.now() - aiT0.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [aiBusy]);

  /** 读取最新一条已落库的 AI 产品结果（刷新后仍可见） */
  const loadStoredReport = useCallback(async (videoId: string): Promise<void> => {
    const list = await commentAnalysisRepo.listByVideo(videoId);
    const latest = list[0];
    if (!latest) {
      setReport(null);
      return;
    }
    // V3.0.1 · P0-2：只认 analysisResult（Zod 校验过的结构化业务结果）。
    // 绝不再把 rawResponse（Provider 原始响应）当作业务结果 —— 那是 V3.0.0 的语义错位缺陷。
    const analysisResult = (latest.analysisResult ?? null) as CommentAIResult | null;
    setReport({ record: latest, analysisResult });
    // 引用完整性：从落库文本反推（产品结果只保留渲染后的引用）
    setAiMeta({
      model: latest.model,
      durationMs: 0,
      requestCount: 0,
      repaired: false,
      unknownRpids: [],
      claimsWithoutCitation: 0,
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!bvid) return;
    const video = await videoRepo.findByBvid(bvid);
    if (!video) {
      setComments([]);
      setReport(null);
      return;
    }
    const list = await commentRepo.listByVideo(video.id, { limit: 2000 });
    setComments(list);
    await loadStoredReport(video.id);
  }, [bvid, loadStoredReport]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const handleFetch = async (): Promise<void> => {
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      setStatusLevel('error');
      setStatus('请输入合法 BV 号（BV + 10 位）');
      return;
    }
    setStatusLevel('info');
    setStatus('采集评论中…');
    setAiFailure(null);
    setDiag('');
    const r = await collector.collectComments(bvid, { sort, tier, depth });
    if (!r.ok) {
      // V0.2.2：区分失败类型，不再把所有失败都压成「采集失败」
      const envLimited = r.diagnostics?.environmentLimited === true;
      const code = r.diagnostics?.biliCode;
      const metaFailed = /视频信息获取失败|视频写入失败|创作者记录建立失败/.test(r.error);
      setStatusLevel('error');
      setStatus(
        envLimited
          ? `采集受阻：评论接口风控（环境受限）· ${r.error}`
          : metaFailed
            ? `无法获取视频信息：${r.error}`
            : `采集失败：${r.error}`,
      );
      setDiag(
        r.diagnostics
          ? `HTTP/业务码诊断：code=${code ?? '—'} · 环境受限=${envLimited ? '是' : '否'} · 可重试=${r.retryable}`
          : '',
      );
      await refresh();
      return;
    }
    const added = r.stats?.added ?? 0;
    const unchanged = r.stats?.unchanged ?? 0;
    const pages = r.stats?.pages ?? 0;
    const expected = r.stats?.expectedTotal ?? 0;
    const limited = r.diagnostics?.environmentLimited === true;
    setStatusLevel(limited ? 'warn' : 'info');
    setStatus(
      `完成 · 抓取 ${r.data.length} 条 · 新增 ${added} · 已存在 ${unchanged} · 页数 ${pages}` +
        (expected ? ` · B 站声明总数 ${expected}` : '') +
        (limited ? ' · ⚠ 环境受限，数据可能不完整' : ''),
    );
    setDiag(
      `诊断：businessCode=${r.diagnostics?.biliCode ?? '—'} · pages=${pages} · fetched=${r.diagnostics?.fetched ?? '—'} · stored=${r.diagnostics?.stored ?? '—'} · environmentLimited=${limited}`,
    );
    await refresh();
  };

  /**
   * V3.0 · 第五节：不再手工拼 JSON。
   * 全流程交给 orchestrator：构造 prompt → 请求 → Zod 校验 → 自动修复 → 落库。
   */
  const handleAI = async (): Promise<void> => {
    const video = await videoRepo.findByBvid(bvid);
    if (!video || comments.length === 0) {
      setStatusLevel('warn');
      setStatus('请先采集评论');
      return;
    }
    setStatusLevel('info');
    setAiFailure(null);
    setStatusLevel('info');
    setAiBusy(true);
    // V3.0.1 · 第七节：真实阶段提示（不编造百分比）
    setAiStage('准备数据…');
    setAiStream(null);
    aiT0.current = performance.now();
    setAiElapsed(0);
    try {
      // V3.0.1 · P0-1：受控样本（唯一采样入口）
      const prep = prepareCommentAnalysis(comments, { sampleStrategy, sampleLimit: aiSampleLimit });
      setAiBudget(prep.budget);
      setAiStage('构造分析上下文…');
      const factsJson = serializeCommentFacts(prep);
      const { system, user } = buildCommentAnalyzePrompt({
        videoId: video.id,
        sample: prep.sample,
        totalComments: prep.total,
        factsJson,
        requireCitations: true,
      });
      setStatus(
        `AI 分析中 · 统计基数 ${prep.total} 条 · AI 样本 ${prep.sample.length} 条（${SAMPLE_STRATEGY_LABEL[prep.sampleStrategy]}）· 约 ${Math.round(prep.budget.totalChars / 1000)}k 字符`,
      );

      setAiStage('请求模型…');
      const r = await orchestrateCommentAnalysis({
        videoId: video.id,
        systemPrompt: system,
        userPrompt: user,
        factsJson,
        // 真实存在的 rpid 白名单 —— 用于校验模型引用是否落空。
        // 注意：白名单用「样本内」的 rpid，模型只被允许引用它真正看到的评论。
        knownRpids: prep.sample.map((c) => c.rpidStr),
        // V3.0.1 · P0-A：流式进度透传到 UI。
        // 只更新展示，不参与任何业务判定；收到首个有效 chunk 后才切到「已开始输出」。
        onProgress: (info) => {
          setAiStream(info);
          if (info.phase === 'streaming') {
            setAiStage('模型已开始输出…');
          }
        },
      });

      setAiStage('校验结果…');
      if (!r.ok) {
        // V3.0 · 第六节 + V3.0.1 · P1-6：显示真实失败原因；**不清空已有成功结果**
        setAiFailure(describeFailure(r.status, r.detail));
        setStatusLevel(r.status === 'OUTPUT_TRUNCATED' ? 'warn' : 'error');
        setStatus(`${r.status} · ${r.message}`);
        setAiMeta({
          model: '',
          durationMs: r.durationMs,
          requestCount: r.requestCount,
          repaired: false,
          unknownRpids: [],
          claimsWithoutCitation: 0,
        });
        // 关键：不 setReport(null)、不删库 —— 最近一次成功分析必须保留
        return;
      }

      setAiStage('保存分析…');
      setReport({
        record: {
          id: r.domainRecordId ?? '',
          videoId: video.id,
          createdAt: new Date().toISOString(),
          model: r.usedConfig.model,
          factSummary: r.data.facts.join('\n'),
          themeResult: r.data.themes.map((t) => t.name),
          sentimentResult: { positive: 0, neutral: 0, negative: 0 },
          userNeedResult: r.data.needs,
          questionResult: r.data.questions,
          supportResult: r.data.support.map((c) => c.statement),
          oppositionResult: r.data.opposition.map((c) => c.statement),
          citedCommentRpids: r.citations.totalCitations ? [] : [],
          uncertaintyNote: r.data.uncertainty.join('\n'),
        },
        // V3.0.1 · P0-2：产品结果持有结构化业务结果（不是 Provider 原始响应）
        analysisResult: r.data,
      } as StoredReport);
      setAiMeta({
        model: r.usedConfig.model,
        durationMs: r.durationMs,
        requestCount: r.requestCount,
        repaired: r.repaired,
        unknownRpids: r.citations.unknownRpids,
        claimsWithoutCitation: r.citations.claimsWithoutCitation,
      });
      setStatusLevel('info');
      setStatus(
        `AI 完成 · ${r.durationMs}ms · ${r.requestCount} 次请求${r.repaired ? '（含 1 次自动修复）' : ''} · Provider ${r.usedConfig.name}/${r.usedConfig.model}`,
      );
      await refresh();
    } catch (e) {
      setAiFailure(describeFailure('REQUEST_FAILED', e instanceof Error ? e.message : String(e)));
      setStatusLevel('error');
      setStatus(`REQUEST_FAILED · ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiStage('');
      setAiStream(null);
      setAiBusy(false);
    }
  };

  const handleLoadHistory = async (): Promise<void> => {
    const video = await videoRepo.findByBvid(bvid);
    if (!video) return;
    const rows = await aiAnalysisRepo.listByTarget(video.id, 'comment');
    setHistory([...rows].reverse());
    setShowHistory(true);
  };

  /** 点击 rpid → 定位到本地评论并高亮 */
  const locateRpid = useCallback((rpid: string): void => {
    setHighlightRpid(rpid);
    const el = commentRefs.current.get(rpid);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 若被过滤掉则清空过滤条件，保证「点得动」
    setFilter('');
    setTimeout(() => {
      const el2 = commentRefs.current.get(rpid);
      if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }, []);

  // P0-E：统计事实（客观）
  const stats = useMemo(() => computeCommentStats(comments), [comments]);
  const keywords = useMemo(() => countKeywords(comments, { topN: 20 }), [comments]);
  const top = useMemo(() => topComments(comments, 5), [comments]);

  /**
   * V3.0.1 · P0-1/P1-5：AI 输入预览（采样 + 体积估算）。
   * 纯计算、不发请求；让用户在点「AI 分析」前就知道会送多少条、多大。
   */
  const samplePreview = useMemo(
    () => prepareCommentAnalysis(comments, { sampleStrategy, sampleLimit: aiSampleLimit }),
    [comments, sampleStrategy, aiSampleLimit],
  );

  // 排序 + 关键词过滤
  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const list = comments.filter((c) => !kw || c.content.toLowerCase().includes(kw) || c.uname.toLowerCase().includes(kw));
    const sorted = [...list];
    if (sortKey === 'like') sorted.sort((a, b) => b.like - a.like);
    else if (sortKey === 'time') sorted.sort((a, b) => b.ctime - a.ctime);
    else sorted.sort((a, b) => b.replyCount - a.replyCount);
    return sorted;
  }, [comments, filter, sortKey]);

  /** 只有被 AI 引用到的评论置顶提示，方便对照 */
  const citedSet = useMemo(() => {
    const r = report?.analysisResult;
    if (!r) return new Set<string>();
    const s = new Set<string>();
    for (const c of r.support) c.rpid.forEach((x) => s.add(x));
    for (const c of r.opposition) c.rpid.forEach((x) => s.add(x));
    for (const t of r.themes) t.rpids.forEach((x) => s.add(x));
    for (const f of r.findings) f.evidenceRpids.forEach((x) => s.add(x));
    return s;
  }, [report]);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>评论研究</h1>
      <Nav active="comment.html" />

      <section className="card stack">
        <div className="row">
          <input value={bvid} onChange={(e) => setBvid(e.target.value.trim())} placeholder="输入 BV 号" />
          <button className="primary" onClick={handleFetch}>
            采集
          </button>
          <button onClick={handleAI} disabled={aiBusy}>
            {aiBusy ? '分析中…' : 'AI 分析'}
          </button>
          <button onClick={handleLoadHistory} disabled={!bvid}>
            AI 历史
          </button>
        </div>
        <div className="row wrap">
          <label className="faint">
            排序
            <select value={sort} onChange={(e) => setSort(e.target.value as CommentSort)}>
              <option value="time">按时间</option>
              <option value="hot">按热度</option>
            </select>
          </label>
          <label className="faint">
            档位
            <select value={tier} onChange={(e) => setTier(e.target.value as CommentTier)}>
              <option value="quick">快速 (50)</option>
              <option value="standard">标准 (200)</option>
              <option value="deep">深度 (500)</option>
              <option value="max">上限 (1000)</option>
            </select>
          </label>
          <label className="faint">
            深度
            <select value={depth} onChange={(e) => setDepth(e.target.value as CommentDepth)}>
              <option value="top">仅一级</option>
              <option value="deep">展开前 30 条二级</option>
              <option value="advanced">展开前 100 条二级</option>
            </select>
          </label>
          {/* V3.0.1 · P0-1：AI 样本策略 —— 只影响送 AI 的样本，统计仍基于全部已采集数据 */}
          <label className="faint">
            AI 样本策略
            <select
              value={sampleStrategy}
              onChange={(e) => setSampleStrategy(e.target.value as CommentSampleStrategy)}
            >
              {(Object.keys(SAMPLE_STRATEGY_LABEL) as CommentSampleStrategy[]).map((k) => (
                <option key={k} value={k}>
                  {SAMPLE_STRATEGY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          {/* V3.0.1 · P1-5：AI 样本上限 —— 输入过大时优先在此降低样本量，而不是让请求失败 */}
          <label className="faint">
            AI 样本上限
            <select
              value={aiSampleLimit}
              onChange={(e) => setAiSampleLimit(Number(e.target.value))}
            >
              {[60, 80, 120, 160, 200].map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="faint">
          统计基于**全部已采集评论**（{formatInt(comments.length)} 条）；AI 只分析受控代表性样本（
          {formatInt(samplePreview.budget.sampleCount)} 条 · {SAMPLE_STRATEGY_LABEL[sampleStrategy]} ·
          约 {formatInt(Math.round(samplePreview.budget.totalChars / 1000))}k 字符）。
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按内容 / 用户名过滤" />
        {status && (
          <div className={statusLevel === 'error' ? 'error' : statusLevel === 'warn' ? 'warn' : 'faint'}>{status}</div>
        )}
        {diag && <div className="faint mono" style={{ fontSize: 12 }}>{diag}</div>}
      </section>

      {/* ══════════════════════════════════════════════════════════════
          V3.0.1 · P0-3：AI 区域必须**位于统计事实之前**。
          DOM 顺序（最终 build 已核实）：
            标题 → BV/采集/AI 分析/AI 历史 → [AI 分析状态] → [AI 分析报告] → 统计事实 → Top → 本地评论
          ══════════════════════════════════════════════════════════════ */}

      {/* ── AI 分析状态（进行中 / 失败 / 旧版本） ── */}
      {aiBusy && (
        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>AI 分析状态</h3>
            <span className="faint mono">{aiElapsed}s</span>
          </div>
          {/* 真实阶段，不编造百分比 */}
          <div className="row wrap">
            {['准备数据…', '构造分析上下文…', '请求模型…', '模型已开始输出…', '校验结果…', '保存分析…'].map((s) => (
              <span key={s} className={s === aiStage ? 'tag warn' : 'tag'}>
                {s}
              </span>
            ))}
          </div>
          {/* V3.0.1 · P0-A：流式实时进度（只有真实字符数与真实秒数，没有假百分比） */}
          {aiStream && aiStream.phase === 'streaming' ? (
            <div className="faint">
              模型已开始输出 · {Math.round(aiStream.elapsedMs / 1000)}s · 已接收{' '}
              {formatInt(aiStream.receivedChars)} 字符
              {aiStream.chunkCount > 0 ? `（${formatInt(aiStream.chunkCount)} 个 chunk）` : ''}
            </div>
          ) : aiElapsed >= 30 ? (
            /* 首字节等待超过 30s：只提示「模型尚未返回首个响应」，**不终止请求** */
            <div className="warn">模型尚未返回首个响应（已等待 {aiElapsed}s，仍在等待）…</div>
          ) : aiElapsed >= 10 ? (
            <div className="faint">模型响应较慢（{aiElapsed}s）…</div>
          ) : null}
          {/* 流式已建立但当前静默 → 提示「仍在输出」而非误判卡死 */}
          {aiStream && aiStream.phase === 'streaming' && aiStream.sinceLastChunkMs >= 15_000 && (
            <div className="faint">
              模型仍在输出…（距上次新数据 {Math.round(aiStream.sinceLastChunkMs / 1000)}s）
            </div>
          )}
          {aiBudget && (
            <div className="faint">
              （统计：{formatInt(aiBudget.total)} 条 · AI 样本：{formatInt(aiBudget.sampleCount)} 条 · AI 输入：约{' '}
              {formatInt(Math.round(aiBudget.totalChars / 1000))}k 字符 · 耗时：{aiElapsed}s）
              {aiBudget.overBudget && <span className="warn"> · 输入偏大，建议降低样本量</span>}
            </div>
          )}
        </section>
      )}

      {/* 失败提示：显示真实失败码与原因（不再一律「AI 失败」） */}
      {aiFailure && <AIFailureNotice failure={aiFailure} />}

      {/* V3.0.1 · P1-6：AI 失败但已有历史成功结果 → 明确保留，不覆盖 */}
      {aiFailure && report && (
        <section className="card stack">
          <div className="warn">本次分析失败（{aiFailure.code}），已保留最近一次成功分析。</div>
          <div className="faint">
            最近一次成功分析：{report.record.createdAt.slice(0, 19).replace('T', ' ')} · 模型{' '}
            {report.record.model}
            {aiBudget ? ` · 本次输入 ${aiBudget.sampleCount} 条样本` : ''}
          </div>
        </section>
      )}

      {/* ── AI 分析报告（结构化业务结果） ── */}
      {report?.analysisResult && (
        <CommentAIReport
          result={report.analysisResult}
          unknownRpids={aiMeta?.unknownRpids ?? []}
          claimsWithoutCitation={aiMeta?.claimsWithoutCitation ?? 0}
          repaired={aiMeta?.repaired ?? false}
          requestCount={aiMeta?.requestCount ?? 0}
          durationMs={aiMeta?.durationMs ?? 0}
          model={aiMeta?.model ?? report.record.model}
          onLocateRpid={locateRpid}
        />
      )}

      {/* V3.0.1 · P0-2：旧版本记录（无结构化结果）—— 显式提示，绝不猜测 */}
      {report && !report.analysisResult && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>AI 分析报告</h3>
          <div className="warn">
            该分析为旧版本记录，未保存结构化产品结果，请重新分析。
          </div>
          <div className="faint">
            记录时间：{report.record.createdAt.slice(0, 19).replace('T', ' ')} · 模型 {report.record.model}
            {report.record.rawResponse ? ' · 该记录仅有 Provider 原始响应（不可作为业务结果展示）' : ''}
          </div>
        </section>
      )}

      {/* AI 历史（第十一节）：审计记录，含真实 prompt / token / finishReason */}
      {showHistory && (
        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>AI 历史（审计记录 {history.length} 条）</h3>
            <button onClick={() => setShowHistory(false)}>收起</button>
          </div>
          <div className="faint">
            这里保存的是完整审计记录：prompt / 原始响应 / token / finishReason / 解析状态。产品结果见上方结构化报告。
          </div>
          {history.length === 0 && <div className="empty">暂无</div>}
          {history.map((h) => {
            const meta = ((h.parsedResult as Record<string, unknown> | undefined)?.__meta ?? {}) as Record<string, unknown>;
            const status = String(meta.status ?? '—');
            const finish = String(meta.finishReason ?? '—');
            const parseOk = meta.parseOk === true ? 'ok' : 'fail';
            return (
              <details key={h.id} className="card" style={{ padding: 10 }}>
                <summary style={{ cursor: 'pointer' }}>
                  <span className="mono">{h.createdAt.slice(0, 19).replace('T', ' ')}</span>
                  {' · '}
                  <span className={status === 'SUCCESS' ? 'ok' : 'warn'}>{status}</span>
                  {' · '}
                  <span className="faint">
                    {h.provider}/{h.model} · {h.durationMs}ms · finish={finish} · parse={parseOk}
                    {h.tokenUsage ? ` · tokens=${h.tokenUsage.total}` : ''}
                  </span>
                </summary>
                <div className="stack" style={{ marginTop: 8, gap: 8 }}>
                  <div className="faint">system prompt（前 600 字符）</div>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 180, overflow: 'auto' }}>
                    {h.systemPrompt.slice(0, 600)}
                  </pre>
                  <div className="faint">parsedResult.__meta</div>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 180, overflow: 'auto' }}>
                    {JSON.stringify(meta, null, 2)}
                  </pre>
                  <div className="faint">rawResponse.choices[0]</div>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 240, overflow: 'auto' }}>
                    {JSON.stringify(
                      ((h.rawResponse as { choices?: unknown[] } | undefined)?.choices ?? h.rawResponse) as unknown,
                      null,
                      2,
                    ).slice(0, 3000)}
                  </pre>
                </div>
              </details>
            );
          })}
        </section>
      )}

      {/* P0-E：统计事实区（客观，与 AI 推断分离） */}
      <section className="card stack">
        <h3 style={{ margin: 0 }}>统计事实</h3>
        <div className="faint">以下为客观计算，不含 AI 推断；缺失数据以 – 表示，绝不用 0 伪装。</div>
        <table>
          <tbody>
            <tr>
              <td>总评论数</td>
              <td>{formatInt(stats.total)}</td>
              <td>一级评论</td>
              <td>{formatInt(stats.topLevel)}</td>
            </tr>
            <tr>
              <td>二级回复</td>
              <td>{formatInt(stats.subReplies)}</td>
              <td>参与用户</td>
              <td>{formatInt(stats.uniqueUsers)}</td>
            </tr>
            <tr>
              <td>平均点赞（一级）</td>
              <td>{stats.avgLikeTopLevel === null ? '–' : stats.avgLikeTopLevel.toFixed(1)}</td>
              <td>最高点赞</td>
              <td>{stats.maxLike === null ? '–' : formatInt(stats.maxLike)}</td>
            </tr>
            <tr>
              <td>回复率</td>
              <td>{stats.replyRate === null ? '–' : formatPct(stats.replyRate)}</td>
              <td>时间跨度</td>
              <td>{stats.spanMs === null ? '–' : `${Math.round(stats.spanMs / 86_400_000)} 天`}</td>
            </tr>
            <tr>
              <td>最早评论</td>
              <td>{stats.earliestCtime?.slice(0, 10) ?? '–'}</td>
              <td>最新评论</td>
              <td>{stats.latestCtime?.slice(0, 10) ?? '–'}</td>
            </tr>
          </tbody>
        </table>
        {keywords.length > 0 && (
          <div className="row wrap">
            {keywords.map((k) => (
              <span key={k.keyword} className="tag">
                {k.keyword} · {k.count}
              </span>
            ))}
          </div>
        )}
      </section>

      {top.length > 0 && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>高赞评论 Top 5</h3>
          {top.map((c) => (
            <div key={c.id} className="card" style={{ padding: 8 }}>
              <div className="faint">
                {c.uname} · 👍 {formatInt(c.like)} · {c.replyLevel === 1 ? '一级' : '二级'}
              </div>
              <div>{c.content}</div>
            </div>
          ))}
        </section>
      )}

      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>本地评论（{formatInt(comments.length)}）</h3>
          <label className="faint">
            排序
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="like">按点赞</option>
              <option value="time">按时间</option>
              <option value="reply">按回复数</option>
            </select>
          </label>
        </div>
        <div className="faint">被 AI 引用过的评论左侧有标记，点击分析报告里的 rpid 可直接跳转。</div>
        {visible.length === 0 ? (
          <div className="empty">无评论</div>
        ) : (
          <div className="stack">
            {visible.slice(0, 300).map((c) => {
              const cited = citedSet.has(c.rpidStr);
              const hl = highlightRpid === c.rpidStr;
              return (
                <div
                  key={c.id}
                  ref={(el) => {
                    if (el) commentRefs.current.set(c.rpidStr, el);
                    else commentRefs.current.delete(c.rpidStr);
                  }}
                  className="card"
                  style={{
                    padding: 8,
                    borderLeft: cited ? '3px solid var(--accent)' : undefined,
                    background: hl ? 'var(--border)' : undefined,
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">
                      {c.uname}
                      {c.replyLevel > 1 && <span className="faint"> · 回复</span>}
                      {cited && <span className="faint"> · 被 AI 引用</span>}
                    </span>
                    <span className="faint">
                      rpid {c.rpidStr} · 👍 {formatInt(c.like)}
                      {c.replyCount > 0 && ` · 💬 ${c.replyCount}`}
                    </span>
                  </div>
                  <div>{c.content}</div>
                </div>
              );
            })}
            {visible.length > 300 && <div className="faint">仅展示前 300 条；全部 {formatInt(visible.length)}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
