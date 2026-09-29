/**
 * V3.1.0 · P1：实验记录（Experiment）面板 + Idea→Experiment 闭环。
 *
 * 「Idea → Experiment」：从灵感页把一条想法转成可验证实验
 *   （hypothesis 预填自灵感标题，ideaId 关联回溯）。
 * 结论字段（actualResult / conclusion）只在实验完成时填写——
 * 绝不在 planned/running 阶段伪造结果。
 */

import { useEffect, useState } from 'react';
import { experimentRepo, ideaRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import type { Experiment, ExperimentStatus, Idea } from '@models/idea';

const STATUS_LABEL: Record<ExperimentStatus, string> = {
  planned: '计划中',
  running: '进行中',
  completed: '已完成',
  aborted: '已中止',
};

const ORDER: ExperimentStatus[] = ['planned', 'running', 'completed', 'aborted'];

export function ExperimentPanel(): JSX.Element {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [status, setStatus] = useState('');

  const refresh = async (): Promise<void> => {
    setExperiments(await experimentRepo.list());
  };

  useEffect(() => {
    refresh().catch(() => setStatus('读取实验失败'));
  }, []);

  const handleStatus = async (id: string, s: ExperimentStatus): Promise<void> => {
    await experimentRepo.update(id, { status: s });
    await refresh();
  };

  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>实验记录</h3>
      {status && <div className="faint">{status}</div>}
      {experiments.length === 0 ? (
        <div className="empty">暂无实验 —— 从上方灵感卡片点「→ 实验」开始一次可验证的尝试</div>
      ) : (
        <div className="stack">
          {experiments.map((e) => (
            <ExperimentCard key={e.id} exp={e} onStatus={handleStatus} onSaved={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

function ExperimentCard({
  exp,
  onStatus,
  onSaved,
}: {
  exp: Experiment;
  onStatus: (id: string, s: ExperimentStatus) => Promise<void>;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [actual, setActual] = useState(exp.actualResult);
  const [conclusion, setConclusion] = useState(exp.conclusion);

  const handleSaveResult = async (): Promise<void> => {
    await experimentRepo.update(exp.id, {
      actualResult: actual.trim(),
      conclusion: conclusion.trim(),
      // 写了结论才算完成；没写结论的完成是自欺
      status: conclusion.trim() ? 'completed' : exp.status,
    });
    setEditing(false);
    await onSaved();
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{exp.hypothesis}</strong>
        <select value={exp.status} onChange={(e) => onStatus(exp.id, e.target.value as ExperimentStatus)}>
          {ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="row wrap">
        {exp.topic && <span className="tag">选题：{exp.topic}</span>}
        {exp.targetAccount && <span className="tag">目标：{exp.targetAccount}</span>}
        {exp.expectedResult && <span className="muted">预期：{exp.expectedResult}</span>}
      </div>
      {exp.actualResult && !editing && <div className="muted">实际：{exp.actualResult}</div>}
      {exp.conclusion && <div className="ok">结论：{exp.conclusion}</div>}
      {editing ? (
        <div className="stack">
          <textarea value={actual} onChange={(e) => setActual(e.target.value)} rows={2} placeholder="实际观察到的结果…" />
          <textarea value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={2} placeholder="结论（填写后自动标记完成）…" />
          <div className="row">
            <button className="primary" onClick={handleSaveResult}>
              保存结果
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setActual(exp.actualResult);
                setConclusion(exp.conclusion);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => setEditing(true)}>记录结果</button>
        </div>
      )}
    </div>
  );
}

/**
 * Idea→Experiment 转换（供灵感页调用）：
 * hypothesis 从灵感标题预填，ideaId 落库保证闭环可追溯。
 */
export async function createExperimentFromIdea(
  idea: Idea,
  patch: { hypothesis: string; targetAccount: string; expectedResult: string },
): Promise<string> {
  const now = nowIso();
  const exp: Experiment = {
    id: newId('exp'),
    hypothesis: patch.hypothesis.trim() || `验证「${idea.title}」是否值得做成内容`,
    targetAccount: patch.targetAccount.trim(),
    topic: idea.tags[0] ?? '',
    ideaId: idea.id,
    videoIds: [],
    expectedResult: patch.expectedResult.trim(),
    actualResult: '',
    conclusion: '',
    status: 'planned',
    createdAt: now,
    updatedAt: now,
  };
  await experimentRepo.add(exp);
  // 灵感侧状态推进：idea → researching（如仍在初始态）
  if (idea.status === 'idea') {
    await ideaRepo.updateStatus(idea.id, 'researching');
  }
  return exp.id;
}
