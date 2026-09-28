import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { HotTopicCollector } from '@collectors/hot-topic-collector';
import { hotTopicRepo } from '@repositories/index';
import { hotTopicToIdea } from '@services/idea-loop';
import type { HotTopic } from '@models/idea';
import { logger } from '@utils/logger';

const collector = new HotTopicCollector();

/** 高风险话题提示（只提示，不阻断，也不做结论） */
const RISK_KEYWORDS = ['政治', '时政', '社会事件', '法律', '事故', '灾难', '战争', '疫情', '举报', '争议'];

function riskHint(topic: HotTopic): string | null {
  const hay = `${topic.title} ${topic.category} ${topic.relatedTags.join(' ')}`;
  const hit = RISK_KEYWORDS.find((k) => hay.includes(k));
  return hit ? `可能涉及「${hit}」等敏感方向，请人工审核后再决定是否跟进` : null;
}

export function HotPage() {
  const [tab, setTab] = useState<'top' | 'search'>('top');
  const [items, setItems] = useState<HotTopic[]>([]);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState<'info' | 'warn' | 'error'>('info');
  const [converted, setConverted] = useState<Set<string>>(new Set());

  const loadCached = async (source: HotTopic['source']): Promise<void> => {
    const list = await hotTopicRepo.listBySource(source, 100);
    setItems(list);
  };

  const handleRefresh = async (): Promise<void> => {
    setStatus('采集中…');
    setStatusKind('info');
    const r = await collector.collect({ targetId: '', context: { mode: tab } });
    if (!r.ok) {
      // P0-D：失败绝不假装成功
      setStatus(`失败：${r.error}`);
      setStatusKind('error');
      return;
    }
    setItems(r.data);
    setStatus(`完成 · ${r.data.length} 条`);
    setStatusKind('info');
  };

  const handleConvert = async (topic: HotTopic): Promise<void> => {
    try {
      const idea = await hotTopicToIdea(topic, {
        tags: topic.relatedTags.slice(0, 10),
        note: `来自热点榜（${topic.source} · 排名 ${topic.rank}）`,
      });
      // 记录已转换，避免重复点击（本次会话内）
      setConverted((prev) => new Set(prev).add(topic.id));
      setStatus(`已转为灵感：${idea.title}（可在「灵感」页查看并流转/建实验）`);
      setStatusKind('info');
    } catch (e) {
      logger.warn(`hotTopicToIdea failed: ${String(e)}`);
      setStatus(`转为灵感失败：${e instanceof Error ? e.message : String(e)}`);
      setStatusKind('error');
    }
  };

  useEffect(() => {
    loadCached(tab === 'top' ? 'bili-hot' : 'bili-search').catch(() => undefined);
  }, [tab]);

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>热点</h1>
      <Nav active="hot.html" />

      <section className="card stack">
        <div className="faint">
          数据来源：B 站公开热门榜 / 热搜词。涉及政治、社会、法律等高风险话题时，仅提示存在风险，请人工审核。
        </div>
        <div className="row">
          <button className={tab === 'top' ? 'primary' : ''} onClick={() => setTab('top')}>
            全站热门
          </button>
          <button className={tab === 'search' ? 'primary' : ''} onClick={() => setTab('search')}>
            热搜词
          </button>
          <button onClick={handleRefresh}>刷新</button>
        </div>
        {status && <div className={statusKind === 'info' ? 'faint' : statusKind}>{status}</div>}
      </section>

      <section className="card stack">
        {items.length === 0 ? (
          <div className="empty">无数据</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>标题</th>
                <th>来源</th>
                <th>分区</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const hint = riskHint(it);
                const done = converted.has(it.id);
                return (
                  <tr key={it.id}>
                    <td>{it.rank}</td>
                    <td>
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noreferrer">
                          {it.title}
                        </a>
                      ) : (
                        it.title
                      )}
                      {hint && <div className="warn faint">{hint}</div>}
                    </td>
                    <td className="faint">{it.source}</td>
                    <td className="faint">{it.category}</td>
                    <td>
                      {done ? (
                        <span className="ok faint">已转灵感</span>
                      ) : (
                        <button onClick={() => handleConvert(it)}>转为灵感</button>
                      )}
                    </td>
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
