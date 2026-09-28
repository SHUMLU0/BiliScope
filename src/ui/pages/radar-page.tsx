import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { SearchCollector } from '@collectors/search-collector';
import { radarKeywordSummary } from '@services/creator-research';
import { runTask } from '@services/task-runner';
import { formatDuration, formatInt } from '@utils/time';
import type { Video } from '@models/video';

const search = new SearchCollector();

export function RadarPage() {
  const [keyword, setKeyword] = useState('');
  const [videos, setVideos] = useState<Video[]>([]);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const handleSearch = async (nextPage = 1): Promise<void> => {
    if (!keyword.trim()) return;
    setStatus('搜索中…');
    // Group G：包成可追踪任务（真实报错在任务页可见）
    const task = await runTask(
      'search',
      keyword,
      () => search.collect({ targetId: keyword, context: { page: nextPage } }),
      { meta: { page: nextPage } },
    );
    if (task.status === 'failed') {
      setStatus(`失败：${task.errorMessage ?? '未知错误'}`);
      return;
    }
    const r = await search.collect({ targetId: keyword, context: { page: nextPage } });
    if (!r.ok) {
      setStatus(`失败：${r.error}`);
      return;
    }
    setVideos((prev) => (nextPage === 1 ? r.data : [...prev, ...r.data]));
    setStatus(`完成 · ${r.data.length} 条`);
    setPage(nextPage);
  };

  // V0.2 · P1（Group C）：全站生态描述性汇总
  const summary = radarKeywordSummary(keyword, videos);

  useEffect(() => {
    // 自动聚焦
  }, []);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>全站雷达</h1>
      <Nav active="radar.html" />

      <section className="card stack">
        <div className="faint">
          基于 B 站公开搜索 API 的<strong>描述性</strong>生态画像。50 万+ 头部结构化分析由后台增量索引逐步构建（V0.2
          起可在「任务」页查看进度）。以下统计不含竞争度判断或推荐结论。
        </div>
        <div className="row">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="关键词，如 AI 工具" />
          <button className="primary" onClick={() => handleSearch(1)}>
            搜索
          </button>
        </div>
        {status && <div className="faint">{status}</div>}
      </section>

      {videos.length > 0 && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>生态画像（客观统计）</h3>
          <div className="faint">{summary.note}</div>
          <div className="row wrap">
            <div className="card" style={{ flex: '1 1 120px' }}>
              <div className="muted faint">结果条数</div>
              <div className="metric">{formatInt(summary.resultCount)}</div>
            </div>
            <div className="card" style={{ flex: '1 1 120px' }}>
              <div className="muted faint">播放中位数</div>
              <div className="metric">{summary.medianViews === null ? '–' : formatInt(summary.medianViews)}</div>
            </div>
            <div className="card" style={{ flex: '1 1 120px' }}>
              <div className="muted faint">播放均值</div>
              <div className="metric">{summary.avgViews === null ? '–' : formatInt(summary.avgViews)}</div>
            </div>
          </div>
          {summary.topAuthors.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>头部作者</th>
                  <th>出现次数</th>
                </tr>
              </thead>
              <tbody>
                {summary.topAuthors.map((a) => (
                  <tr key={a.author}>
                    <td>{a.author}</td>
                    <td>{a.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card stack">
        {videos.length === 0 ? (
          <div className="empty">无结果</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>UP</th>
                <th>播放</th>
                <th>BV</th>
                <th>时长</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => (
                <tr key={v.bvid}>
                  <td>
                    <a href={`comment.html?bvid=${v.bvid}`}>{v.title}</a>
                  </td>
                  {/* V0.1.2（P0-4）：此前整列显示的是字面量 "search" */}
                  <td className="faint">
                    {v.authorName ?? (v.authorMid ? `uid:${v.authorMid}` : '—')}
                  </td>
                  {/* 缺失即显示 –，不用 0 伪装 */}
                  <td>{formatInt(v.views)}</td>
                  <td className="mono faint">{v.bvid}</td>
                  <td>{formatDuration(v.duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {videos.length > 0 && (
          <button onClick={() => handleSearch(page + 1)}>加载更多</button>
        )}
      </section>
    </div>
  );
}