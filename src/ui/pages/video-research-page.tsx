/**
 * V3.1.0 · P1：视频库（Video Research）。
 *
 * 本地 videos 表的全量浏览视图：标题 / UP 主 / 发布时间 / 最新快照指标。
 * 只读本地（禁联网）；每一行可直达「评论研究」。
 * 指标缺失显示 –（unknown ≠ 0）；快照数为 0 的视频照样列出（它有本地记录）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Nav } from '../components/Nav';
import { db } from '@db/database';
import { formatDuration, formatInt } from '@utils/time';
import type { Video, VideoSnapshot } from '@models/video';

type SortKey = 'pubTime' | 'views' | 'likes' | 'comments';

interface Row {
  video: Video;
  latest: VideoSnapshot | undefined;
}

export function VideoResearchPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<SortKey>('pubTime');

  useEffect(() => {
    void (async () => {
      try {
        // 限制 300 条（浏览器 IndexedDB 游标足够快；UI 只做研究浏览不是全量分析）
        const videos = await db.videos.orderBy('pubTime').reverse().limit(300).toArray();
        const snaps = await db.videoSnapshots.toArray();
        // 每个 videoId 取 timestamp 最新的一条快照
        const latestById = new Map<string, VideoSnapshot>();
        for (const s of snaps) {
          const cur = latestById.get(s.videoId);
          if (!cur || cur.timestamp < s.timestamp) latestById.set(s.videoId, s);
        }
        setRows(videos.map((v) => ({ video: v, latest: latestById.get(v.id) })));
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const kw = keyword.trim().toLowerCase();
    const out = kw
      ? rows.filter(
          (r) =>
            r.video.title.toLowerCase().includes(kw) ||
            r.video.bvid.toLowerCase().includes(kw) ||
            (r.video.authorName ?? '').toLowerCase().includes(kw),
        )
      : rows;
    const v = (r: Row): number =>
      sort === 'pubTime'
        ? r.video.pubTime
          ? Date.parse(r.video.pubTime)
          : 0
        : (r.latest?.[sort] ?? -1);
    return [...out].sort((a, b) => v(b) - v(a));
  }, [rows, keyword, sort]);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>视频库</h1>
      <Nav active="video-research.html" />

      {error && <div className="error">读取本地数据失败：{error}</div>}

      <section className="card stack">
        <div className="row wrap">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="按标题 / BV 号 / UP 主过滤…"
            style={{ flex: '2 1 260px' }}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ flex: '1 1 140px' }}>
            <option value="pubTime">按发布时间</option>
            <option value="views">按播放（最新快照）</option>
            <option value="likes">按点赞（最新快照）</option>
            <option value="comments">按评论（最新快照）</option>
          </select>
        </div>
        <div className="faint">
          只读本地 videos 表（最近 300 条）。指标来自每个视频的**最新一次快照**；「–」表示还没有快照数据。
        </div>
      </section>

      <section className="card">
        {rows === null ? (
          <div className="empty">读取中…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">没有匹配的视频 —— 先去「评论研究」粘贴 BV 号采集</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>UP 主</th>
                <th>发布</th>
                <th>时长</th>
                <th>播放</th>
                <th>点赞</th>
                <th>评论</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.video.id}>
                  <td>{r.video.title}</td>
                  <td>{r.video.authorName ?? '–'}</td>
                  <td className="mono">{r.video.pubTime ? r.video.pubTime.slice(0, 10) : '–'}</td>
                  <td>{r.video.duration != null ? formatDuration(r.video.duration) : '–'}</td>
                  <td>{formatInt(r.latest?.views)}</td>
                  <td>{formatInt(r.latest?.likes)}</td>
                  <td>{formatInt(r.latest?.comments)}</td>
                  <td>
                    <a href={`comment.html?bvid=${encodeURIComponent(r.video.bvid)}`}>评论研究</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
