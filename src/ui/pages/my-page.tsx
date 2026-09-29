import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { DataPortPanel } from '../components/DataPortPanel';
import { CreatorCollector } from '@collectors/creator-collector';
import { VideoCollector } from '@collectors/video-collector';
import { creatorRepo, videoRepo, videoSnapshotRepo } from '@repositories/index';
import { runTask } from '@services/task-runner';
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
    // Group G：整条链路登记为一个任务，失败/环境受限在「任务」页可见
    const task = await runTask<Creator | null>(
      'my-data',
      uid,
      async () => {
        const cr = await creatorC.collect({ targetId: uid });
        if (!cr.ok) {
          // 环境受限（如未登录/风控）不伪装成功
          return cr;
        }
        const vr = await videoC.collectByCreator(Number(uid));
        if (!vr.ok) {
          return {
            ok: false as const,
            error: `视频失败：${vr.error}`,
            retryable: vr.retryable,
            diagnostics: vr.diagnostics,
          };
        }
        return {
          ok: true as const,
          data: cr.data[0] ? [cr.data[0]] : [],
          fetched: cr.fetched,
          diagnostics: cr.diagnostics ?? vr.diagnostics,
        };
      },
      { meta: { uid } },
    );

    if (task.status === 'failed') {
      setStatus(`失败：${task.errorMessage ?? '未知错误'}`);
      return;
    }
    const c = await creatorRepo.findByUid(Number(uid));
    if (!c) {
      setStatus('未找到本地 creator');
      return;
    }
    setCreator(c);
    const list = await videoRepo.listByCreator(c.id, { limit: 200 });
    setVideos(list);
    const sn: Record<string, VideoSnapshot[]> = {};
    for (const v of list.slice(0, 30)) {
      sn[v.id] = await videoSnapshotRepo.listByVideo(v.id);
    }
    setSnapshots(sn);
    const suffix = task.status === 'partial' ? '（环境受限，数据可能不完整）' : '';
    setStatus(`完成 · ${list.length} 视频${suffix}`);
  };

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>我的数据</h1>
      <Nav active="my.html" />

      <section className="card stack">
        <div className="faint">
          V0.2 仍以手动输入 UID 为主（不读取登录态）；采集全过程登记为任务，可在「任务」页查看进度与诊断。
        </div>
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

      {/* V3.1.0 · P1：数据导入 / 导出 */}
      <DataPortPanel />
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