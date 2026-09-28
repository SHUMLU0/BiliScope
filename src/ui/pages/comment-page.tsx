import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { CommentCollector } from '@collectors/comment-collector';
import { commentRepo, videoRepo } from '@repositories/index';
import { aiAnalyze } from '@ai/service';
import { buildCommentAnalyzePrompt } from '@ai/prompts';
import { formatInt } from '@utils/time';
import type { Comment } from '@models/comment';

const collector = new CommentCollector();

export function CommentPage() {
  const [bvid, setBvid] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState('');
  const [aiText, setAiText] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const b = sp.get('bvid');
    if (b) setBvid(b);
  }, []);

  const refresh = async (): Promise<void> => {
    if (!bvid) return;
    const video = await videoRepo.findByBvid(bvid);
    if (!video) return;
    const list = await commentRepo.listByVideo(video.id, { limit: 500 });
    setComments(list);
  };

  const handleFetch = async () => {
    if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) {
      setStatus('请输入合法 BV 号（BV1xxxxxxxxxx）');
      return;
    }
    setStatus('采集评论中…');
    const r = await collector.collect({ targetId: bvid });
    if (!r.ok) {
      setStatus(`失败：${r.error}`);
      return;
    }
    // V0.1.2（P1-7）：用真实入库计数，r.data 含已存在评论，不能直接当新增数
    const added = r.stats?.added ?? 0;
    const unchanged = r.stats?.unchanged ?? 0;
    setStatus(`完成 · 本次新增 ${added} 条 · 已存在 ${unchanged} 条 · 本次抓到 ${r.data.length} 条`);
    await refresh();
  };

  const handleAI = async () => {
    const video = await videoRepo.findByBvid(bvid);
    if (!video) {
      setStatus('请先采集');
      return;
    }
    setStatus('AI 分析评论中…');
    setAiText('');
    try {
      const { system, user } = buildCommentAnalyzePrompt({ videoId: video.id, comments });
      const r = await aiAnalyze({
        type: 'comment',
        targetId: video.id,
        request: { systemPrompt: system, userPrompt: user, jsonMode: true, temperature: 0.2 },
      });
      setAiText(JSON.stringify(r.response.parsed ?? r.response.text, null, 2));
      setStatus(`AI 完成 · ${r.analysis.durationMs}ms`);
    } catch (e) {
      setStatus(`AI 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    if (bvid) {
      refresh().catch(() => undefined);
    }
    // refresh intentionally omitted — only re-run when bvid changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bvid]);

  const filtered = comments.filter(
    (c) => !filter || c.content.toLowerCase().includes(filter.toLowerCase()),
  );

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
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按内容过滤" />
        {status && <div className="faint">{status}</div>}
      </section>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>本地评论（{formatInt(comments.length)}）</h3>
        <div className="faint">
          强制 anti-词云幻觉：除词云外必须提供主题 / 高频问题 / 支持 / 反对 / 用户痛点。词云仅作辅助。
        </div>
        {filtered.length === 0 ? (
          <div className="empty">无评论</div>
        ) : (
          <div className="stack">
            {filtered.slice(0, 100).map((c) => (
              <div key={c.id} className="card" style={{ padding: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">{c.uname}</span>
                  <span className="faint">👍 {formatInt(c.like)}</span>
                </div>
                <div>{c.content}</div>
              </div>
            ))}
            {filtered.length > 100 && (
              <div className="faint">仅展示前 100 条；全部 {formatInt(filtered.length)}</div>
            )}
          </div>
        )}
      </section>

      {aiText && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>AI 分析结果</h3>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {aiText}
          </pre>
        </section>
      )}
    </div>
  );
}