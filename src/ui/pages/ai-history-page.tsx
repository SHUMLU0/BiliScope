/**
 * AI 历史页（V3.0 · 第十一节）。
 *
 * 职责：把 `AIAnalysis`（**审计记录**）如实展示出来 ——
 *   时间 / 类型 / Provider / 模型 / 状态 / finishReason / token / 耗时 / 解析状态，
 * 并可展开查看当时的 prompt 与原始响应。
 *
 * 与「评论研究」页的区别：
 *   - 评论页展示的是**产品结果**（`CommentAnalysis`，结构化分析报告）
 *   - 本页展示的是**审计记录**（`AIAnalysis`，模型到底收到了什么、返回了什么）
 *
 * 数据口径：只读 `aiAnalysisRepo`，不做任何推断，不把「无记录」显示成「0 次」。
 */

import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { db } from '@db/database';
import type { AIAnalysis } from '@models/task';

interface Row extends AIAnalysis {
  meta: Record<string, unknown>;
}

function readMeta(a: AIAnalysis): Record<string, unknown> {
  const parsed = a.parsedResult as Record<string, unknown> | undefined;
  const meta = parsed?.__meta;
  return (meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}) as Record<string, unknown>;
}

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: '成功',
  REQUEST_FAILED: '请求失败',
  OUTPUT_EMPTY: '空输出',
  OUTPUT_TRUNCATED: '输出被截断',
  OUTPUT_INVALID_JSON: 'JSON 非法',
  OUTPUT_SCHEMA_INVALID: '结构不符',
  OUTPUT_REFUSAL: '模型拒答',
  NO_PROVIDER: '未配置 Provider',
};

export function AiHistoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<'all' | AIAnalysis['type']>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    try {
      // 按 createdAt 倒序取最近 200 条；表可能为空 → 显示「暂无」，不伪造 0 条统计
      const all = await db.aiAnalyses.toArray();
      const sorted = all
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 200)
        .map((a) => ({ ...a, meta: readMeta(a) }));
      setRows(sorted);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const visible = typeFilter === 'all' ? rows : rows.filter((r) => r.type === typeFilter);

  const counts = {
    success: rows.filter((r) => r.meta.status === 'SUCCESS').length,
    failed: rows.filter((r) => r.meta.status && r.meta.status !== 'SUCCESS').length,
    legacy: rows.filter((r) => !r.meta.status).length,
  };

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>AI 历史</h1>
      <Nav active="ai-history.html" />

      <section className="card stack">
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>审计记录</h3>
          <button onClick={() => load()}>刷新</button>
        </div>
        <div className="faint">
          这里保存每一次 AI 调用的完整证据：prompt、原始响应、token、finishReason、解析状态。
          产品结果（结构化分析报告）在「评论研究」页查看。
        </div>
        <div className="row wrap">
          <span className="tag ok">成功 {counts.success}</span>
          <span className="tag danger">失败 {counts.failed}</span>
          {counts.legacy > 0 && <span className="tag warn">V3.0 前旧记录 {counts.legacy}（无状态字段）</span>}
        </div>
        <div className="row wrap">
          {(['all', 'comment', 'creator', 'video', 'idea'] as const).map((t) => (
            <button key={t} className={typeFilter === t ? 'primary' : ''} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? '全部' : t}
            </button>
          ))}
        </div>
      </section>

      {loadError && <div className="error">读取失败：{loadError}</div>}

      {loading ? (
        <div className="card empty">
          <span className="spinner" /> 加载中…
        </div>
      ) : visible.length === 0 ? (
        <div className="card empty">暂无 AI 调用记录</div>
      ) : (
        <section className="card stack">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>Provider / 模型</th>
                <th>状态</th>
                <th>finishReason</th>
                <th>解析</th>
                <th>tokens</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const status = String(r.meta.status ?? '（旧记录）');
                const finish = r.meta.finishReason ? String(r.meta.finishReason) : '—';
                const parseOk = r.meta.parseOk === undefined ? '—' : r.meta.parseOk === true ? 'ok' : 'fail';
                return (
                  <tr
                    key={r.id}
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {r.createdAt.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td>{r.type}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {r.provider}/{r.model}
                    </td>
                    <td className={status === 'SUCCESS' ? 'ok' : r.meta.status ? 'warn' : 'faint'}>
                      {STATUS_LABEL[status] ?? status}
                    </td>
                    <td className="mono">
                      <span className={finish === 'length' || finish === 'MAX_TOKENS' ? 'warn' : ''}>{finish}</span>
                    </td>
                    <td className={parseOk === 'fail' ? 'warn' : ''}>{parseOk}</td>
                    <td>{r.tokenUsage ? r.tokenUsage.total : '—'}</td>
                    <td>{r.durationMs}ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {expanded && (
        <section className="card stack">
          {(() => {
            const r = visible.find((x) => x.id === expanded);
            if (!r) return <div className="faint">记录已刷新</div>;
            return (
              <>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>记录详情 {r.id}</h3>
                  <button onClick={() => setExpanded(null)}>关闭</button>
                </div>
                <div className="faint">
                  targetId={r.targetId} · 实际下发上限 {String(r.meta.usedMaxTokens ?? '—')} tokens · 结构化输出=
                  {String(r.meta.structuredOutput ?? '—')} · 请求次数 {String(r.meta.requestCount ?? '—')} · 尝试
                  {String(r.meta.attempt ?? '—')}
                </div>
                {r.meta.parseError ? <div className="warn">JSON 解析错误：{String(r.meta.parseError)}</div> : null}
                {r.meta.refusal ? <div className="warn">模型拒答：{String(r.meta.refusal)}</div> : null}
                {Array.isArray(r.meta.citations) ? (
                  <div className="faint">引用审计：{JSON.stringify(r.meta.citations)}</div>
                ) : null}

                <details open>
                  <summary style={{ cursor: 'pointer' }}>system prompt</summary>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 260, overflow: 'auto' }}>
                    {r.systemPrompt}
                  </pre>
                </details>
                <details>
                  <summary style={{ cursor: 'pointer' }}>user prompt</summary>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 360, overflow: 'auto' }}>
                    {r.userPrompt}
                  </pre>
                </details>
                <details>
                  <summary style={{ cursor: 'pointer' }}>原始响应（rawResponse）</summary>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 420, overflow: 'auto' }}>
                    {JSON.stringify(r.rawResponse, null, 2)}
                  </pre>
                </details>
                <details>
                  <summary style={{ cursor: 'pointer' }}>解析结果 + 元数据</summary>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 420, overflow: 'auto' }}>
                    {JSON.stringify(r.parsedResult, null, 2)}
                  </pre>
                </details>
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
