/**
 * V3.1.0 · P1：选题库（Topic）管理面板。
 *
 * 数据：topics 表（name / tags / competitionLevel / notes）。
 * 约定：competitionLevel 是**人工判断**字段（unknown 默认），不是任何接口抓来的
 * 指标 —— UI 不伪造竞争度数据。
 */

import { useEffect, useState } from 'react';
import { topicRepo } from '@repositories/index';
import type { Topic } from '@models/idea';

const LEVEL_LABEL: Record<Topic['competitionLevel'], string> = {
  unknown: '未知',
  low: '低竞争',
  medium: '中竞争',
  high: '高竞争',
};

const LEVEL_CLASS: Record<Topic['competitionLevel'], string> = {
  unknown: 'tag',
  low: 'tag ok',
  medium: 'tag warn',
  high: 'tag danger',
};

const LEVELS: Topic['competitionLevel'][] = ['unknown', 'low', 'medium', 'high'];

export function TopicPanel(): JSX.Element {
  const [name, setName] = useState('');
  const [level, setLevel] = useState<Topic['competitionLevel']>('unknown');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState('');

  const refresh = async (): Promise<void> => {
    setTopics(await topicRepo.list());
  };

  useEffect(() => {
    refresh().catch(() => setStatus('读取选题失败'));
  }, []);

  const handleAdd = async (): Promise<void> => {
    const n = name.trim();
    if (!n) {
      setStatus('请输入选题名称');
      return;
    }
    // upsertByName：同名合并，不重复建卡
    await topicRepo.upsertByName(n, { competitionLevel: level });
    setName('');
    setLevel('unknown');
    setStatus(`已保存：${n}`);
    await refresh();
  };

  const handleRemove = async (t: Topic): Promise<void> => {
    if (!confirm(`删除选题「${t.name}」？`)) return;
    await topicRepo.remove(t.id);
    await refresh();
  };

  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>选题库</h3>
      <div className="row wrap">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新选题：一句话命名…"
          style={{ flex: '2 1 220px' }}
        />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as Topic['competitionLevel'])}
          style={{ flex: '1 1 120px' }}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              竞争度：{LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
        <button className="primary" onClick={handleAdd}>
          添加
        </button>
      </div>
      {status && <div className="faint">{status}</div>}
      {topics.length === 0 ? (
        <div className="empty">暂无选题 —— 从热点或评论里发现的候选话题都记在这里</div>
      ) : (
        <div className="stack">
          {topics.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong>{t.name}</strong>
                {t.notes && <span className="faint"> · {t.notes}</span>}
              </span>
              <span className="row" style={{ gap: 8 }}>
                <select
                  value={t.competitionLevel}
                  onChange={(e) => {
                    void (async () => {
                      await topicRepo.upsertByName(t.name, {
                        competitionLevel: e.target.value as Topic['competitionLevel'],
                      });
                      await refresh();
                    })();
                  }}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {LEVEL_LABEL[l]}
                    </option>
                  ))}
                </select>
                <span className={LEVEL_CLASS[t.competitionLevel]}>{LEVEL_LABEL[t.competitionLevel]}</span>
                <button onClick={() => handleRemove(t)}>删除</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
