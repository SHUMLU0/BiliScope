/**
 * 评论 AI 分析结果的结构化展示（V3.0 · 第十节）。
 *
 * ⚠️ 禁止再用 `<pre>{JSON}</pre>` 当主展示。
 * 普通用户看到的应当是「分析」，而不是模型的 JSON 转储。
 *
 * 固定分区（顺序即阅读顺序）：
 *   1 核心结论 · 2 客观事实 · 3 主题 · 4 支持观点 · 5 质疑/反对 ·
 *   6 用户需求 · 7 争议与情绪 · 8 不确定性 · 9 下一步研究
 * 底部：`查看原始 AI 输出`（高级审计用，默认折叠）。
 */

import { useState, type ReactNode } from 'react';
import type { CommentAIResult, Finding } from '@ai/schemas';
import type { AIFailureInfo } from '@ai/failures';

/** finding 类型 → 中文标签（供「发现」区块与诊断展示复用） */
export const FINDING_LABEL: Record<Finding['type'], string> = {
  theme: '主题',
  painpoint: '痛点',
  emotion: '情绪',
  controversy: '争议',
  behavior: '行为',
};

/** 引用徽章（匿名 ref，如 C001）：点击时把对应评论滚入视野并高亮（定位由页面层经 citationMap 回溯） */
export function RefChip({ refId, onLocate }: { refId: string; onLocate?: (ref: string) => void }): ReactNode {
  return (
    <button
      type="button"
      className="tag mono"
      title={`定位到评论 引用=${refId}`}
      onClick={() => onLocate?.(refId)}
      style={{ cursor: onLocate ? 'pointer' : 'default', padding: '0 6px', fontSize: 11 }}
    >
      {refId}
    </button>
  );
}

function Section({
  index,
  title,
  hint,
  children,
  tone,
}: {
  index: number;
  title: string;
  hint?: string;
  children: ReactNode;
  tone?: 'warn' | 'ok';
}): ReactNode {
  return (
    <section className="card stack" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h4 style={{ margin: 0 }}>
          <span className="faint" style={{ marginRight: 6 }}>
            {index}
          </span>
          {title}
        </h4>
        {hint && <span className={`faint${tone === 'warn' ? ' warn' : tone === 'ok' ? ' ok' : ''}`}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="faint">{children}</div>;
}

function Bullets({ items, empty }: { items: string[]; empty: string }): ReactNode {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export interface CommentAIReportProps {
  result: CommentAIResult;
  /** 断言的引用数与真实引用数的差异（可验证性提示；存匿名 ref） */
  unknownRefs: string[];
  claimsWithoutCitation: number;
  repaired: boolean;
  requestCount: number;
  durationMs: number;
  model: string;
  /** 是否发生过截断/修复等需要提示的情况 */
  notice?: string;
  /** 点击匿名 ref → 页面层经 citationMap 回溯真实 rpid 并定位 */
  onLocateRef?: (ref: string) => void;
}

export function CommentAIReport(props: CommentAIReportProps): ReactNode {
  const { result, unknownRefs, claimsWithoutCitation, repaired, requestCount, durationMs, model, notice } = props;
  const [showRaw, setShowRaw] = useState(false);

  // 「争议 / 情绪」从 findings 里筛出来（它们本就是结构化字段，不必再让模型重复输出一遍）
  const controversies = result.findings.filter((f) => f.type === 'controversy');
  const emotions = result.findings.filter((f) => f.type === 'emotion');
  const painpoints = result.findings.filter((f) => f.type === 'painpoint');
  const behaviors = result.findings.filter((f) => f.type === 'behavior');
  const themeFindings = result.findings.filter((f) => f.type === 'theme');

  const ClaimList = ({
    claims,
    emptyText,
  }: {
    claims: CommentAIResult['support'];
    emptyText: string;
  }): ReactNode => {
    if (!claims.length) return <Empty>{emptyText}</Empty>;
    return (
      <div className="stack" style={{ gap: 8 }}>
        {claims.map((c, i) => (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <div>{c.statement}</div>
            <div className="row wrap" style={{ gap: 4 }}>
              {c.refs.length ? (
                c.refs.map((r) => <RefChip key={r} refId={r} onLocate={props.onLocateRef} />)
              ) : (
                <span className="faint warn">无引用（该观点未指向任何真实评论）</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const FindingBlock = ({ items, label }: { items: Finding[]; label: string }): ReactNode => {
    if (!items.length) return null;
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="faint">{label}</div>
        {items.map((f, i) => (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <div>{f.statement}</div>
            <div className="row wrap" style={{ gap: 4 }}>
              {f.evidenceRefs.length ? (
                f.evidenceRefs.map((r) => <RefChip key={r} refId={r} onLocate={props.onLocateRef} />)
              ) : (
                <span className="faint">无引用</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // 可验证性提示：只在真的有问题时出现，避免噪声
  const integrityWarnings: string[] = [];
  if (claimsWithoutCitation > 0) {
    integrityWarnings.push(`${claimsWithoutCitation} 条观点没有评论引用`);
  }
  if (unknownRefs.length > 0) {
    integrityWarnings.push(`${unknownRefs.length} 个引用不在本批样本内（模型可能臆造）`);
  }

  return (
    <div className="stack">
      <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>AI 分析结果</h3>
        <span className="faint mono">
          {model} · {durationMs}ms · {requestCount} 次请求{repaired ? ' · 已自动修复一次' : ''}
        </span>
      </div>

      {notice && <div className="warn">{notice}</div>}

      {integrityWarnings.length > 0 && (
        <div className="card" style={{ padding: 10, borderColor: 'var(--warn)' }}>
          <div className="warn" style={{ fontWeight: 500 }}>
            引用完整性提示
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {integrityWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <div className="faint">下列结论请结合上方统计事实与原始评论核对后再使用。</div>
        </div>
      )}

      {/* 1 核心结论 */}
      <Section index={1} title="核心结论">
        {result.summary ? <div style={{ fontSize: 15 }}>{result.summary}</div> : <Empty>模型未给出结论</Empty>}
      </Section>

      {/* 2 客观事实 */}
      <Section index={2} title="客观事实" hint="来自给定数据，非 AI 推断" tone="ok">
        <Bullets items={result.facts} empty="无" />
      </Section>

      {/* 3 主题 */}
      <Section index={3} title="主题" hint={`${result.themes.length} 个`}>
        {result.themes.length === 0 ? (
          <Empty>未识别出主题</Empty>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {result.themes.map((t, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div>
                  <strong>{t.name}</strong>
                  {typeof t.mentionCount === 'number' && <span className="faint"> · 提及 {t.mentionCount} 条</span>}
                </div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {t.refs.length ? (
                    t.refs.slice(0, 12).map((r) => <RefChip key={r} refId={r} onLocate={props.onLocateRef} />)
                  ) : (
                    <span className="faint warn">未给出对应评论</span>
                  )}
                  {t.refs.length > 12 && <span className="faint">…共 {t.refs.length} 条</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {themeFindings.length > 0 && <FindingBlock items={themeFindings} label="补充主题判断" />}
      </Section>

      {/* 4 支持观点 */}
      <Section index={4} title="支持观点" hint="每项须带评论引用">
        <ClaimList claims={result.support} emptyText="未提炼出支持观点" />
      </Section>

      {/* 5 质疑 / 反对观点 */}
      <Section index={5} title="质疑 / 反对观点" hint="每项须带评论引用">
        <ClaimList claims={result.opposition} emptyText="未提炼出反对观点" />
      </Section>

      {/* 6 用户需求 */}
      <Section index={6} title="用户需求">
        <Bullets items={result.needs} empty="未识别出明确需求" />
        {result.questions.length > 0 && (
          <>
            <div className="faint" style={{ marginTop: 8 }}>
              高频问题
            </div>
            <Bullets items={result.questions} empty="无" />
          </>
        )}
      </Section>

      {/* 7 争议与情绪 */}
      <Section index={7} title="争议 / 情绪 / 痛点">
        {controversies.length + emotions.length + painpoints.length + behaviors.length === 0 ? (
          <Empty>未识别出争议或显著情绪</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <FindingBlock items={controversies} label="争议点" />
            <FindingBlock items={painpoints} label="痛点" />
            <FindingBlock items={emotions} label="情绪" />
            <FindingBlock items={behaviors} label="行为" />
          </div>
        )}
      </Section>

      {/* 8 不确定性 */}
      <Section index={8} title="不确定性" hint="请先读这一段" tone="warn">
        <Bullets items={result.uncertainty} empty="模型未说明不确定性（这本身是风险信号）" />
      </Section>

      {/* 9 下一步研究 */}
      <Section index={9} title="下一步要采集的数据">
        <Bullets items={result.nextResearch} empty="无建议" />
      </Section>

      {/* 底部：原始输出（高级审计） */}
      <div className="card stack" style={{ padding: 10 }}>
        <button onClick={() => setShowRaw((v) => !v)} style={{ alignSelf: 'flex-start' }}>
          {showRaw ? '收起原始 AI 输出' : '查看原始 AI 输出'}
        </button>
        {showRaw && (
          <>
            <div className="faint">以下为模型返回的结构化对象（已通过 Zod 校验）。审计用的完整 prompt / token / finishReason 见「AI 历史」。</div>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflow: 'auto' }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

/** 失败态展示：必须显示**真实原因**，不许一律「AI 失败」 */
export function AIFailureNotice({ failure }: { failure: AIFailureInfo }): ReactNode {
  const tone = failure.code === 'OUTPUT_TRUNCATED' ? 'warn' : 'error';
  return (
    <div className="card stack" style={{ padding: 12, borderColor: tone === 'warn' ? 'var(--warn)' : 'var(--danger)' }}>
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <strong className={tone}>AI 分析未完成</strong>
        <span className="tag mono">{failure.code}</span>
      </div>
      <div>{failure.message}</div>
      {failure.detail && (
        <details>
          <summary className="faint" style={{ cursor: 'pointer' }}>
            技术细节
          </summary>
          <pre className="mono faint" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
            {failure.detail}
          </pre>
        </details>
      )}
      <div className="faint">
        {failure.retryable ? '可重试；若反复出现请检查 Provider 配置与该模型的输出上限。' : '该请求不可通过重试解决。'}
      </div>
    </div>
  );
}
