import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { CreatorCollector } from '@collectors/creator-collector';
import { VideoCollector } from '@collectors/video-collector';
import { aiAnalyze } from '@ai/service';
import { buildCreatorAnalyzePrompt } from '@ai/prompts';
import { creatorSnapshotRepo, videoRepo } from '@repositories/index';
import { formatDuration, formatInt, nowIso } from '@utils/time';
import type { Creator, CreatorSnapshot, Video } from '@models/index';

const creatorCollector = new CreatorCollector();
const videoCollector = new VideoCollector();

export function CreatorPage() {
  const [uid, setUid] = useState('');
  const [creator, setCreator] = useState<Creator | null>(null);
  const [snapshots, setSnapshots] = useState<CreatorSnapshot[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [status, setStatus] = useState('');
  const [aiText, setAiText] = useState('');

  const refresh = async (c: Creator): Promise<void> => {
    const [sn, vd] = await Promise.all([
      creatorSnapshotRepo.listByCreator(c.id),
      videoRepo.listByCreator(c.id, { limit: 30 }),
    ]);
    setSnapshots(sn.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)));
    setVideos(vd);
  };

  const handleFetch = async () => {
    if (!/^\d+$/.test(uid)) {
      setStatus('请输入合法 UID（纯数字）');
      return;
    }
    setStatus('采集账号…');
    const r1 = await creatorCollector.collect({ targetId: uid });
    if (!r1.ok) {
      setStatus(`失败：${r1.error}`);
      return;
    }
    const c = r1.data[0];
    if (!c) {
      setStatus('返回为空');
      return;
    }
    setStatus(`已采集 ${c.name}（${c.followers} 粉丝）`);
    setCreator(c);
    await refresh(c);
    setStatus('采集视频列表…');
    const r2 = await videoCollector.collectByCreator(c.uid);
    if (!r2.ok) {
      setStatus(`视频失败：${r2.error}`);
    } else {
      setStatus(`完成 · ${r2.data.length} 视频`);
      await refresh(c);
    }
  };

  const handleAI = async () => {
    if (!creator) return;
    setStatus('AI 分析中…');
    setAiText('');
    try {
      const ctx = { creator, recentVideos: videos, recentSnapshots: snapshots };
      const { system, user } = buildCreatorAnalyzePrompt(ctx);
      const r = await aiAnalyze({
        type: 'creator',
        targetId: creator.id,
        request: { systemPrompt: system, userPrompt: user, jsonMode: true, temperature: 0.2 },
      });
      setAiText(JSON.stringify(r.response.parsed ?? r.response.text, null, 2));
      setStatus(`AI 完成 · ${r.analysis.durationMs}ms`);
    } catch (e) {
      setStatus(`AI 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    // init from URL ?uid=
    const sp = new URLSearchParams(location.search);
    const u = sp.get('uid');
    if (u) setUid(u);
  }, []);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>账号研究</h1>
      <Nav active="creator.html" />

      <section className="card stack">
        <div className="row">
          <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="输入 B 站 UID（纯数字）" />
          <button className="primary" onClick={handleFetch}>
            采集
          </button>
        </div>
        {status && <div className="faint">{status}</div>}
      </section>

      {creator && (
        <>
          <section className="card stack">
            <h3 style={{ margin: 0 }}>{creator.name}</h3>
            <div className="muted">{creator.sign}</div>
            <div className="row wrap">
              <Metric label="粉丝" value={formatInt(creator.followers)} />
              <Metric label="关注" value={formatInt(creator.following)} />
              <Metric label="投稿" value={formatInt(creator.videoCount)} />
              <Metric label="等级" value={String(creator.level)} />
            </div>
            <div className="row">
              <button onClick={handleAI}>AI 分析</button>
              <a href={`https://space.bilibili.com/${creator.uid}/`} target="_blank" rel="noreferrer">
                <button>打开空间 ↗</button>
              </a>
            </div>
          </section>

          <section className="card stack">
            <h3 style={{ margin: 0 }}>粉丝 / 投稿 趋势</h3>
            {snapshots.length === 0 ? (
              <div className="empty">暂无快照</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>粉丝</th>
                    <th>关注</th>
                    <th>投稿</th>
                    <th>总播放</th>
                    <th>总点赞</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id}>
                      <td className="faint">{s.timestamp.replace('T', ' ').slice(0, 16)}</td>
                      <td>{formatInt(s.followers)}</td>
                      <td>{formatInt(s.following)}</td>
                      <td>{formatInt(s.videoCount)}</td>
                      <td>{formatInt(s.totalViews)}</td>
                      <td>{formatInt(s.totalLikes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card stack">
            <h3 style={{ margin: 0 }}>视频（最近 {videos.length}）</h3>
            {videos.length === 0 ? (
              <div className="empty">暂无视频</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>发布时间</th>
                    <th>时长</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <a href={`comment.html?bvid=${v.bvid}`}>{v.title}</a>
                        <div className="faint">{v.bvid}</div>
                      </td>
                      <td className="faint">{v.pubTime.slice(0, 10)}</td>
                      <td>{formatDuration(v.duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {aiText && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>AI 分析结果</h3>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {aiText}
              </pre>
              <div className="faint">更新于 {nowIso().slice(0, 19).replace('T', ' ')}</div>
            </section>
          )}
        </>
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