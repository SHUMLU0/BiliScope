import { useCallback, useEffect, useMemo, useState } from 'react';
import { Nav } from '../components/Nav';
import { CommentCollector } from '@collectors/comment-collector';
import { commentRepo, videoRepo } from '@repositories/index';
import { aiAnalyze } from '@ai/service';
import { buildCommentAnalyzePrompt } from '@ai/prompts';
import { computeCommentStats, countKeywords, topComments } from '@services/analytics';
import { prepareCommentAnalysis, serializeCommentFacts } from '@services/comment-prep';
import { formatInt, formatPct } from '@utils/time';
import type { Comment, CommentTier, CommentSort, CommentDepth } from '@models/comment';

const collector = new CommentCollector();

type SortKey = 'like' | 'time' | 'reply';

export function CommentPage() {
  const [bvid, setBvid] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState('');
  const [statusLevel, setStatusLevel] = useState<'info' | 'warn' | 'error'>('info');
  const [aiText, setAiText] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('like');
  // 采集档位（P0-A/B）
  const [sort, setSort] = useState<CommentSort>('time');
  const [tier, setTier] = useState<CommentTier>('standard');
  const [depth, setDepth] = useState<CommentDepth>('top');
  // 真实环境诊断（P1）
  const [diag, setDiag] = useState<string>('');

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const b = sp.get('bvid');
    if (b) setBvid(b);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!bvid) return;
    const video = await videoRepo.findByBvid(bvid);
    if (!video) {
      setComments([]);
      return;
    }
    const list = await commentRepo.listByVideo(video.id, { limit: 2000 });
    setComments(list);
  }, [bvid]);

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
    setDiag('');
    const r = await collector.collectComments(bvid, { sort, tier, depth });
    if (!r.ok) {
      // V0.2.2：区分失败类型，不再把所有失败都压成「采集失败」
      //   1) 视频元数据获取失败（/view 非 0 / 网络 / 非法 BV）→ 明确说明
      //   2) 评论接口风控 → 走 environmentLimited 诊断
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

  const handleAI = async (): Promise<void> => {
    const video = await videoRepo.findByBvid(bvid);
    if (!video || comments.length === 0) {
      setStatusLevel('warn');
      setStatus('请先采集评论');
      return;
    }
    setStatusLevel('info');
    setStatus('AI 分析评论中…（先算统计事实，再交给模型解释）');
    setAiText('');
    try {
      // P0-F：统计事实与 AI 推断分离
      const prep = prepareCommentAnalysis(comments);
      const { system, user } = buildCommentAnalyzePrompt({
        videoId: video.id,
        comments,
        factsJson: serializeCommentFacts(prep),
        requireCitations: true,
      });
      const r = await aiAnalyze({
        type: 'comment',
        targetId: video.id,
        request: { systemPrompt: system, userPrompt: user, jsonMode: true, temperature: 0.2 },
      });
      setAiText(JSON.stringify(r.response.parsed ?? r.response.text, null, 2));
      setStatus(`AI 完成 · ${r.analysis.durationMs}ms`);
    } catch (e) {
      setStatusLevel('error');
      setStatus(`AI 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // P0-E：统计事实（客观）
  const stats = useMemo(() => computeCommentStats(comments), [comments]);
  const keywords = useMemo(() => countKeywords(comments, { topN: 20 }), [comments]);
  const top = useMemo(() => topComments(comments, 5), [comments]);

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
          <button onClick={handleAI}>AI 分析</button>
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
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按内容 / 用户名过滤" />
        {status && (
          <div className={statusLevel === 'error' ? 'error' : statusLevel === 'warn' ? 'warn' : 'faint'}>{status}</div>
        )}
        {diag && <div className="faint mono" style={{ fontSize: 12 }}>{diag}</div>}
      </section>

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
        {visible.length === 0 ? (
          <div className="empty">无评论</div>
        ) : (
          <div className="stack">
            {visible.slice(0, 200).map((c) => (
              <div key={c.id} className="card" style={{ padding: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">
                    {c.uname}
                    {c.replyLevel > 1 && <span className="faint"> · 回复</span>}
                  </span>
                  <span className="faint">
                    👍 {formatInt(c.like)}
                    {c.replyCount > 0 && ` · 💬 ${c.replyCount}`}
                  </span>
                </div>
                <div>{c.content}</div>
              </div>
            ))}
            {visible.length > 200 && <div className="faint">仅展示前 200 条；全部 {formatInt(visible.length)}</div>}
          </div>
        )}
      </section>

      {aiText && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>AI 分析结果（推测，须与上方统计事实对照阅读）</h3>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {aiText}
          </pre>
        </section>
      )}
    </div>
  );
}
