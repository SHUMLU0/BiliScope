import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { CreatorCollector } from '@collectors/creator-collector';
import { VideoCollector } from '@collectors/video-collector';
import { creatorRepo, videoRepo, videoSnapshotRepo } from '@repositories/index';
import { formatInt } from '@utils/time';
import type { Creator, Video, VideoSnapshot } from '@models/index';

const creatorC = new CreatorCollector();
const videoC = new VideoCollector();

const MY_UID_KEY = 'biliscope.my.uid.v1';

export function MyDataPage() {
  const [uid, setUid] = useState('');
  const [creator, setCreator] = useState<Creator | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, VideoSnapshot[]>>({});
  const [status, setStatus] = useState('');

  useEffect(() => {
    try {
      const v = localStorage.getItem(MY_UID_KEY);
      if (v) setUid(v);
    } catch {
      /* ignore */
    }
  }, []);

  const handleSaveUid = (v: string): void => {
    setUid(v);
    try {
      localStorage.setItem(MY_UID_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const handleFetch = async (): Promise<void> => {
    if (!/^\d+$/.test(uid)) {
      setStatus('请输入合法 UID');
      return;
    }
    setStatus('采集中…');
    const cr = await creatorC.collect({ targetId: uid });
    if (!cr.ok) {
      setStatus(`失败：${cr.error}`);
      return;
    }
    setCreator(cr.data[0] ?? null);
    const vr = await videoC.collectByCreator(Number(uid));
    if (!vr.ok) {
      setStatus(`视频失败：${vr.error}`);
      return;
    }
    const c = await creatorRepo.findByUid(Number(uid));
    if (!c) {
      setStatus('未找到本地 creator');
      return;
    }
    const list = await videoRepo.listByCreator(c.id, { limit: 200 });
    setVideos(list);
    const sn: Record<string, VideoSnapshot[]> = {};
    for (const v of list.slice(0, 30)) {
      sn[v.id] = await videoSnapshotRepo.listByVideo(v.id);
    }
    setSnapshots(sn);
    setStatus(`完成 · ${list.length} 视频`);
  };

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>我的数据</h1>
      <Nav active="my.html" />

      <section className="card stack">
        <div className="faint">V0.1 仅支持手动输入 UID；账号绑定在 V0.2 引入。</div>
        <div className="row">
          <input value={uid} onChange={(e) => handleSaveUid(e.target.value)} placeholder="你的 B 站 UID" />
          <button className="primary" onClick={handleFetch}>
            采集
          </button>
        </div>
        {status && <div className="faint">{status}</div>}
      </section>

      {creator && (
        <section className="card">
          <div className="row wrap">
            <Metric label="粉丝" value={formatInt(creator.followers)} />
            <Metric label="关注" value={formatInt(creator.following)} />
            <Metric label="投稿" value={formatInt(creator.videoCount)} />
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section className="card stack">
          <h3 style={{ margin: 0 }}>视频表现</h3>
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>最近播放</th>
                <th>点赞</th>
                <th>投币</th>
                <th>收藏</th>
                <th>评论</th>
                <th>弹幕</th>
                <th>快照数</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => {
                const list = snapshots[v.id] ?? [];
                const last = list.length > 0 ? list[list.length - 1] : undefined;
                return (
                  <tr key={v.id}>
                    <td>
                      <a href={`comment.html?bvid=${v.bvid}`}>{v.title}</a>
                    </td>
                    <td>{formatInt(last?.views)}</td>
                    <td>{formatInt(last?.likes)}</td>
                    <td>{formatInt(last?.coins)}</td>
                    <td>{formatInt(last?.favorites)}</td>
                    <td>{formatInt(last?.comments)}</td>
                    <td>{formatInt(last?.danmaku)}</td>
                    <td>{list.length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="faint">如果某项显示「–」，代表暂无快照（不是 0）。</div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card" style={{ flex: '1 1 100px' }}>
      <div className="muted faint">{label}</div>
      <div className="metric">{value}</div>
    </div>
  );
}