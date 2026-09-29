/**
 * V3.1.0 · P0：研究台（Dashboard）。
 *
 * 定位：本地研究数据的**只读总览** —— KPI + 最近动态。
 * 红线：**禁联网**（不 import 任何 collector / fetch），只读 Dexie；
 * 统计口径遵循「unknown ≠ 0」：没有数据的位置显示 –，绝不显示 0 冒充。
 * AI 分析次数**排除探针行**（requestType === 'probe'，V3.0.2 审计分区）。
 */

import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { db } from '@db/database';
import type { AIAnalysis, CommentAnalysis, Video } from '@models/index';

interface Kpis {
  videos: number;
  comments: number;
  creators: number;
  aiAnalyses: number | null; // null = 统计失败（显示 –）
  snapshots: number;
  commentAnalyses: number;
  recentTaskTotal: number;
  recentTaskOk: number;
}

interface RecentLists {
  ai: AIAnalysis[];
  commentAnalyses: CommentAnalysis[];
  /**
   * V3.2.1 · P0：Video.id → Video 映射。
   * CommentAnalysis.videoId 存的是**本地 Dexie Video.id**（不是 bvid）——
   * 旧实现直接把它当 bvid 拼 comment.html 链接，点了必进错误页面。
   * 链接必须经映射换算成真实 `video.bvid`；Video 记录缺失时不生成 href。
   */
  videoById: Map<string, Video>;
}

export function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [recent, setRecent] = useState<RecentLists>({ ai: [], commentAnalyses: [], videoById: new Map() });
  const [error, setError] = useState('');

  useEffect(() => {
    void loadKpis();
  }, []);

  const loadKpis = async (): Promise<void> => {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const [
        videos,
        comments,
        creators,
        aiTotal,
        aiProbe,
        videoSnaps,
        creatorSnaps,
        commentAnalyses,
        recentTasks,
        ai,
        ca,
        videoRows,
      ] = await Promise.all([
        db.videos.count(),
        db.comments.count(),
        db.creators.count(),
        db.aiAnalyses.count(),
        db.aiAnalyses.filter((a) => a.requestType === 'probe').count(),
        db.videoSnapshots.count(),
        db.creatorSnapshots.count(),
        db.commentAnalyses.count(),
        db.collectionTasks.where('createdAt').aboveOrEqual(sevenDaysAgo).toArray(),
        db.aiAnalyses
          .orderBy('createdAt')
          .reverse()
          .filter((a) => a.requestType !== 'probe')
          .limit(6)
          .toArray(),
        db.commentAnalyses.orderBy('createdAt').reverse().limit(6).toArray(),
        // V3.2.1 · P0：id→Video 映射数据源（与统计并行取，互不阻塞）
        db.videos.toArray(),
      ]);
      const videoById = new Map<string, Video>(videoRows.map((v) => [v.id, v]));
      const ok = recentTasks.filter((t) => t.status === 'success' || t.status === 'partial').length;
      setKpis({
        videos,
        comments,
        creators,
        aiAnalyses: Math.max(0, aiTotal - aiProbe),
        snapshots: videoSnaps + creatorSnaps,
        commentAnalyses,
        recentTaskTotal: recentTasks.length,
        recentTaskOk: ok,
      });
      setRecent({ ai, commentAnalyses: ca, videoById });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>研究台</h1>
      <Nav active="dashboard.html" />

      {error && <div className="error">读取本地数据失败：{error}</div>}

      {/* ── KPI 总览（只读，禁联网） ── */}
      <section className="card">
        <div className="row wrap">
          <Metric label="视频" value={fmt(kpis?.videos)} />
          <Metric label="评论" value={fmt(kpis?.comments)} />
          <Metric label="账号" value={fmt(kpis?.creators)} />
          <Metric label="AI 分析" value={fmt(kpis?.aiAnalyses)} />
          <Metric label="快照" value={fmt(kpis?.snapshots)} />
          <Metric label="评论研究" value={fmt(kpis?.commentAnalyses)} />
          <Metric
            label="7 日任务成功率"
            value={
              kpis && kpis.recentTaskTotal > 0
                ? `${Math.round((kpis.recentTaskOk / kpis.recentTaskTotal) * 100)}%`
                : '–'
            }
          />
        </div>
        <div className="faint">
          全部来自本地 IndexedDB；本页不发起任何网络请求。「–」表示暂无数据（不是 0）。
        </div>
      </section>

      {kpis && kpis.videos === 0 && kpis.comments === 0 && (
        <section className="card stack">
          <strong>还没有本地数据</strong>
          <span className="muted">
            从「评论研究」粘贴 BV 号开始，或在 B 站视频页直接用扩展采集。所有数据只存在你的浏览器里。
          </span>
        </section>
      )}

      {/* ── 最近 AI 分析（排除探针行） ── */}
      <section className="card stack">
        <h3 style={{ margin: 0 }}>最近 AI 分析</h3>
        {recent.ai.length === 0 ? (
          <div className="empty">暂无 AI 分析记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>对象</th>
                <th>模型</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {recent.ai.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{shortTime(a.createdAt)}</td>
                  <td>{AI_TYPE_LABEL[a.type] ?? a.type}</td>
                  <td className="mono">{a.targetId}</td>
                  <td className="mono">{a.model}</td>
                  <td>{a.durationMs > 0 ? `${(a.durationMs / 1000).toFixed(1)}s` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── 最近评论研究 ── */}
      <section className="card stack">
        <h3 style={{ margin: 0 }}>最近评论研究</h3>
        {recent.commentAnalyses.length === 0 ? (
          <div className="empty">暂无评论研究记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>视频</th>
                <th>引用评论</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {recent.commentAnalyses.map((c) => {
                // V3.2.1 · P0：videoId 是本地 Video.id，必须经映射换算成真实 bvid 再拼链接；
                // Video 记录缺失 → 显示「视频记录缺失」纯文本，绝不生成错误 href
                const linkedVideo = recent.videoById.get(c.videoId);
                return (
                <tr key={c.id}>
                  <td className="mono">{shortTime(c.createdAt)}</td>
                  <td>
                    {linkedVideo ? (
                      <a href={`comment.html?bvid=${encodeURIComponent(linkedVideo.bvid)}`}>{linkedVideo.bvid}</a>
                    ) : (
                      <span className="faint">视频记录缺失</span>
                    )}
                  </td>
                  <td>{c.citedCommentRpids.length > 0 ? c.citedCommentRpids.length : '–'}</td>
                  <td>{c.analysisResult ? '有结果' : '待重分析'}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const AI_TYPE_LABEL: Record<AIAnalysis['type'], string> = {
  creator: '账号',
  comment: '评论',
  video: '视频',
  idea: '灵感',
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n.toLocaleString('zh-CN');
}

function shortTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const d = new Date(t);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card" style={{ flex: '1 1 120px' }}>
      <div className="muted faint">{label}</div>
      <div className="metric">{value}</div>
    </div>
  );
}
