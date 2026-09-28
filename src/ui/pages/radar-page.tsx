import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { SearchCollector } from '@collectors/search-collector';
import { formatInt } from '@utils/time';
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
    const r = await search.collect({ targetId: keyword, context: { page: nextPage } });
    if (!r.ok) {
      setStatus(`失败：${r.error}`);
      return;
    }
    setVideos((prev) => (nextPage === 1 ? r.data : [...prev, ...r.data]));
    setStatus(`完成 · ${r.data.length} 条`);
    setPage(nextPage);
  };

  useEffect(() => {
    // 自动聚焦
  }, []);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>全站雷达</h1>
      <Nav active="radar.html" />

      <section className="card stack">
        <div className="faint">
          V0.1 实现：基于 B 站公开搜索 API。50 万+ 头部结构化分析将在 V0.2 引入增量索引。
        </div>
        <div className="row">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="关键词，如 AI 工具" />
          <button className="primary" onClick={() => handleSearch(1)}>
            搜索
          </button>
        </div>
        {status && <div className="faint">{status}</div>}
      </section>

      <section className="card stack">
        {videos.length === 0 ? (
          <div className="empty">无结果</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>UP</th>
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
                  <td className="faint">{v.creatorId}</td>
                  <td className="mono faint">{v.bvid}</td>
                  <td>{formatInt(v.duration)}</td>
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