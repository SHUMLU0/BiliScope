import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { CreatorCollector } from '@collectors/creator-collector';
import { VideoCollector } from '@collectors/video-collector';
import { aiAnalyze } from '@ai/service';
import { buildCreatorAnalyzePrompt } from '@ai/prompts';
import { creatorRepo, creatorSnapshotRepo, videoRepo } from '@repositories/index';
import { computeCreatorDelta } from '@services/analytics';
import {
  creatorContentStructure,
  creatorContentChange,
  detectBreakoutVideos,
} from '@services/creator-research';
import { runTask } from '@services/task-runner';
import { formatDuration, formatInt, formatPct, nowIso } from '@utils/time';
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

  // V0.2 · P1（Group C）：账号内容结构 / 变化 / 突破（纯描述性统计，非预测）
  const structure = creatorContentStructure(videos);
  const change = creatorContentChange(videos);
  const breakouts = detectBreakoutVideos(videos);
  const delta = computeCreatorDelta(snapshots);

  // V0.1.3：哪些指标本次真的没拿到（null），在状态区如实说明，不用 0 糊过去
  const unavailable = creator
    ? [
        creator.followers === null ? '粉丝' : null,
        creator.following === null ? '关注' : null,
        creator.videoCount === null ? '投稿' : null,
        creator.level === null ? '等级' : null,
      ].filter((x): x is string => x !== null)
    : [];

  const refresh = async (c: Creator): Promise<void> => {
    const [sn, vd] = await Promise.all([
      creatorSnapshotRepo.listByCreator(c.id),
      videoRepo.listByCreator(c.id, { limit: 100 }),
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
    // Group G：包成可追踪任务
    const task = await runTask('creator', uid, () => creatorCollector.collect({ targetId: uid }));
    if (task.status === 'failed') {
      setStatus(`失败：${task.errorMessage ?? '未知错误'}`);
      return;
    }
    const c = await creatorRepo.findByUid(Number(uid));
    if (!c) {
      setStatus('返回为空');
      return;
    }
    setCreator(c);
    await refresh(c);
    setStatus(`已采集 ${c.name}（粉丝 ${formatInt(c.followers)}）· 采集视频列表…`);
    const r2 = await videoCollector.collectByCreator(c.uid);
    if (!r2.ok) {
      setStatus(`视频失败：${r2.error}`);
    } else {
      setStatus(`完成 · ${r2.data.length} 视频（新增 ${r2.stats?.added ?? 0} / 更新 ${r2.stats?.updated ?? 0}）`);
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
              <Metric label="等级" value={formatInt(creator.level)} />
            </div>
            {unavailable.length > 0 && (
              <div className="faint">该字段当前不可用（匿名接口未提供）：{unavailable.join('、')}</div>
            )}
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
                    <th>播放</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <a href={`comment.html?bvid=${v.bvid}`}>{v.title}</a>
                        <div className="faint">{v.bvid}</div>
                      </td>
                      <td className="faint">{v.pubTime ? v.pubTime.slice(0, 10) : '–'}</td>
                      <td>{formatDuration(v.duration)}</td>
                      <td className="faint">{formatInt(v.views)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card stack">
            <h3 style={{ margin: 0 }}>内容结构（客观统计）</h3>
            <div className="faint">{structure.note}</div>
            {structure.videoCount === 0 ? (
              <div className="empty">暂无视频</div>
            ) : (
              <>
                <div className="row wrap">
                  <Metric label="已采集视频" value={formatInt(structure.videoCount)} />
                  <Metric
                    label="主要分区"
                    value={structure.categoryDistribution[0]?.key ?? '–'}
                  />
                  <Metric
                    label="主分区占比"
                    value={
                      structure.categoryDistribution[0]
                        ? formatPct(structure.categoryDistribution[0].ratio)
                        : '–'
                    }
                  />
                </div>
                {structure.durationDistribution.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>时长区间</th>
                        <th>数量</th>
                        <th>占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {structure.durationDistribution.map((d) => (
                        <tr key={d.key}>
                          <td>{d.key}</td>
                          <td>{d.count}</td>
                          <td className="faint">{formatPct(d.ratio)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {structure.topTags.length > 0 && (
                  <div className="row wrap">
                    {structure.topTags.map((t) => (
                      <span key={t.tag} className="tag">
                        {t.tag} · {t.count}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="card stack">
            <h3 style={{ margin: 0 }}>内容变化（前 / 后半段对比）</h3>
            <div className="faint">{change.note}</div>
            {change.earlyCount === 0 ? (
              <div className="empty">可比样本不足</div>
            ) : (
              <table>
                <tbody>
                  <tr>
                    <td>主分区</td>
                    <td>
                      {change.earlyTopCategory ?? '–'} → {change.recentTopCategory ?? '–'}
                      {change.categoryShifted && <span className="warn"> · 已变化</span>}
                    </td>
                  </tr>
                  <tr>
                    <td>平均时长</td>
                    <td>
                      {change.earlyAvgDuration === null ? '–' : `${Math.round(change.earlyAvgDuration)}s`} →{' '}
                      {change.recentAvgDuration === null ? '–' : `${Math.round(change.recentAvgDuration)}s`}
                      {change.durationDelta !== null && (
                        <span className="faint">（{change.durationDelta >= 0 ? '+' : ''}{Math.round(change.durationDelta)}s）</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td>发布频率（每 30 天）</td>
                    <td>
                      {change.earlyRatePer30d === null ? '–' : change.earlyRatePer30d.toFixed(1)} →{' '}
                      {change.recentRatePer30d === null ? '–' : change.recentRatePer30d.toFixed(1)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </section>

          {breakouts.length > 0 && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>突破视频（≥ 中位数 2 倍）</h3>
              <div className="faint">相对该账号自身播放中位数的倍数，仅为事实描述，非走向预测。</div>
              <table>
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>播放</th>
                    <th>倍数</th>
                  </tr>
                </thead>
                <tbody>
                  {breakouts.slice(0, 10).map((b) => (
                    <tr key={b.videoId}>
                      <td>
                        <a href={`comment.html?bvid=${b.bvid}`}>{b.title}</a>
                      </td>
                      <td>{formatInt(b.views)}</td>
                      <td className="mono">{b.multipleOfMedian.toFixed(1)}×</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {delta && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>账号变化（首 → 末快照）</h3>
              <div className="row wrap">
                <Metric label="粉丝变化" value={delta.followerDelta === null ? '–' : `${delta.followerDelta >= 0 ? '+' : ''}${formatInt(delta.followerDelta)}`} />
                <Metric label="投稿变化" value={delta.videoCountDelta === null ? '–' : `${delta.videoCountDelta >= 0 ? '+' : ''}${delta.videoCountDelta}`} />
                <Metric label="总播放变化" value={delta.totalViewsDelta === null ? '–' : `${delta.totalViewsDelta >= 0 ? '+' : ''}${formatInt(delta.totalViewsDelta)}`} />
              </div>
              <div className="faint">
                覆盖 {delta.elapsedMs === null ? '–' : `${Math.round(delta.elapsedMs / 3_600_000)} 小时`}；仅描述差异，不解读原因。
              </div>
            </section>
          )}

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