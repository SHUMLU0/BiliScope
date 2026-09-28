import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { HotTopicCollector } from '@collectors/hot-topic-collector';
import { hotTopicRepo } from '@repositories/index';
import type { HotTopic } from '@models/idea';

const collector = new HotTopicCollector();

export function HotPage() {
  const [tab, setTab] = useState<'top' | 'search'>('top');
  const [items, setItems] = useState<HotTopic[]>([]);
  const [status, setStatus] = useState('');

  const loadCached = async (source: HotTopic['source']): Promise<void> => {
    const list = await hotTopicRepo.listBySource(source, 100);
    setItems(list);
  };

  const handleRefresh = async (): Promise<void> => {
    setStatus('采集中…');
    const r = await collector.collect({ targetId: '', context: { mode: tab } });
    if (!r.ok) {
      setStatus(`失败：${r.error}`);
      return;
    }
    setItems(r.data);
    setStatus(`完成 · ${r.data.length} 条`);
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
        {status && <div className="faint">{status}</div>}
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
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
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
                  </td>
                  <td className="faint">{it.source}</td>
                  <td className="faint">{it.category}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}