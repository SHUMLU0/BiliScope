/**
 * 评论 AI 分析结果的结构化展示（V3.2.0 · Research Analyst 研究报告视图）。
 *
 * ⚠️ 禁止再用 `<pre>{JSON}</pre>` 当主展示。
 * 普通用户看到的应当是「研究判断」，而不是模型的 JSON 转储。
 *
 * V3.2.0 固定分区（顺序即阅读顺序 —— 用户第一眼先看到 AI 得出的**结论**，而不是统计复述）：
 *   1 核心判断（summary + claims + 相关事实） · 2 评论区结构（主/反/次叙事） ·
 *   3 核心矛盾 · 4 用户群体 · 5 为什么会产生这种讨论（可能机制） ·
 *   6 信号 / 噪声 · 7 对内容研究意味着什么 · 8 可验证假设 ·
 *   9 用户需求 · 10 不确定性 · 11 下一步研究 ·
 *   12 原始分析（V3.1.x 遗留分类字段，默认折叠，仅旧记录可见）
 * 底部：`查看原始 AI 输出`（高级审计用，默认折叠）。
 *
 * ⚠️ V3.1.x 旧记录兼容：遗留字段（facts/themes/support/opposition/findings）
 *   运行时可能仍存在于落库的 analysisResult 中；本组件按「有则展示、无则说明」防御性渲染，
 *   绝不回推、绝不假装字段存在。
 */

import { useState, type ReactNode } from 'react';
import type {
  CommentAIResult,
  Confidence,
  Narrative,
  NarrativeRole,
} from '@ai/schemas';
import type { AIFailureInfo } from '@ai/failures';

/** 叙事角色 → 中文标签 */
export const NARRATIVE_ROLE_LABEL: Record<NarrativeRole, string> = {
  primary: '主叙事',
  secondary: '次叙事',
  counter: '反叙事',
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

/** 引用行：有 refs 渲染 chips，无 refs 显式标注「无引用」（不假装有证据） */
function RefsRow({ refs, onLocate, emptyText }: { refs: string[]; onLocate?: (ref: string) => void; emptyText?: string }): ReactNode {
  if (!refs.length) return <span className="faint warn">{emptyText ?? '无引用（该判断未指向任何真实评论）'}</span>;
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {refs.map((r) => (
        <RefChip key={r} refId={r} onLocate={onLocate} />
      ))}
    </div>
  );
}

/** 置信度徽章：high=绿 / medium=默认 / low=警示 */
function ConfidenceBadge({ value }: { value: Confidence }): ReactNode {
  const cls = value === 'high' ? 'ok' : value === 'low' ? 'warn' : 'faint';
  const label = value === 'high' ? '置信度 高' : value === 'medium' ? '置信度 中' : '置信度 低';
  return <span className={`tag ${cls}`} style={{ fontSize: 11 }}>{label}</span>;
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

/** 叙事条目（主 / 反 / 次共用） */
function NarrativeItem({ n, onLocate }: { n: Narrative; onLocate?: (ref: string) => void }): ReactNode {
  const roleCls = n.role === 'primary' ? 'ok' : n.role === 'counter' ? 'warn' : 'faint';
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
        <strong>{n.name}</strong>
        <span className={`tag ${roleCls}`} style={{ fontSize: 11 }}>
          {NARRATIVE_ROLE_LABEL[n.role]}
        </span>
      </div>
      <div>{n.description}</div>
      <RefsRow refs={n.refs} onLocate={onLocate} emptyText="未给出对应评论" />
    </div>
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
  const [showLegacy, setShowLegacy] = useState(false);

  // V3.1.x 遗留分类字段（旧记录运行时可能存在；新记录 schema 已移除）—— 防御性读取
  const legacy = result as unknown as {
    facts?: string[];
    themes?: Array<{ name?: string; refs?: string[] }>;
    support?: Array<{ statement?: string; refs?: string[] }>;
    opposition?: Array<{ statement?: string; refs?: string[] }>;
    findings?: Array<{ type?: string; statement?: string; evidenceRefs?: string[] }>;
  };
  const legacyItems: string[] = [];
  for (const t of legacy.themes ?? []) {
    if (t?.name) legacyItems.push(`主题：${t.name}（引用 ${(t.refs ?? []).length} 条）`);
  }
  for (const c of legacy.support ?? []) {
    if (c?.statement) legacyItems.push(`支持：${c.statement}`);
  }
  for (const c of legacy.opposition ?? []) {
    if (c?.statement) legacyItems.push(`反对：${c.statement}`);
  }
  for (const f of legacy.findings ?? []) {
    if (f?.statement) legacyItems.push(`发现（${f.type ?? '—'}）：${f.statement}`);
  }

  // 评论区结构分组（展示顺序：主叙事 → 反叙事 → 次叙事）
  const primaryNarratives = result.narratives.filter((n) => n.role === 'primary');
  const counterNarratives = result.narratives.filter((n) => n.role === 'counter');
  const secondaryNarratives = result.narratives.filter((n) => n.role === 'secondary');

  // 可验证性提示：只在真的有问题时出现，避免噪声
  const integrityWarnings: string[] = [];
  if (claimsWithoutCitation > 0) {
    integrityWarnings.push(`${claimsWithoutCitation} 条判断/机制没有评论引用`);
  }
  if (unknownRefs.length > 0) {
    integrityWarnings.push(`${unknownRefs.length} 个引用不在本批样本内（模型可能臆造）`);
  }

  return (
    <div className="stack">
      <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>AI 分析结果</h3>
        <span className="faint mono">
          {model} · {durationMs > 0 ? `${durationMs}ms` : '—'} ·{' '}
          {requestCount > 0 ? `${requestCount} 次请求` : '—'}
          {repaired ? ' · 已自动修复一次' : ''}
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

      {/* 1 核心判断（summary + claims + 相关事实） */}
      <Section index={1} title="核心判断">
        {result.summary ? (
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.5 }}>{result.summary}</div>
        ) : (
          <Empty>模型未给出核心判断</Empty>
        )}
        {result.claims.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">关键判断（带置信度）</div>
            {result.claims.map((c, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
                  <span>{c.statement}</span>
                  <ConfidenceBadge value={c.confidence} />
                </div>
                <RefsRow refs={c.refs} onLocate={props.onLocateRef} />
              </div>
            ))}
          </div>
        )}
        {result.relevantFacts.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="faint">相关事实（仅保留支撑判断的输入事实，不复述统计区）</div>
            <Bullets items={result.relevantFacts} empty="无" />
          </div>
        )}
      </Section>

      {/* 2 评论区结构（主 / 反 / 次叙事） */}
      <Section index={2} title="评论区结构" hint={`主 ${primaryNarratives.length} · 反 ${counterNarratives.length} · 次 ${secondaryNarratives.length}`}>
        {result.narratives.length === 0 ? (
          <Empty>样本不足以重建叙事结构（模型未强行编造）</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {primaryNarratives.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="faint ok">主叙事</div>
                {primaryNarratives.map((n, i) => (
                  <NarrativeItem key={`p${i}`} n={n} onLocate={props.onLocateRef} />
                ))}
              </div>
            )}
            {counterNarratives.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="faint warn">反叙事</div>
                {counterNarratives.map((n, i) => (
                  <NarrativeItem key={`c${i}`} n={n} onLocate={props.onLocateRef} />
                ))}
              </div>
            )}
            {secondaryNarratives.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="faint">次叙事</div>
                {secondaryNarratives.map((n, i) => (
                  <NarrativeItem key={`s${i}`} n={n} onLocate={props.onLocateRef} />
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* 3 核心矛盾 */}
      <Section index={3} title="核心矛盾" hint="观点间真正的冲突结构">
        {result.tensions.length === 0 ? (
          <Empty>未识别出值得呈现的核心矛盾</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {result.tensions.map((t, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 500 }}>{t.statement}</div>
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="card" style={{ padding: '4px 8px', flex: '1 1 240px' }}>
                    <span className="faint" style={{ marginRight: 6 }}>A 方</span>
                    {t.sideA}
                  </span>
                  <span className="card" style={{ padding: '4px 8px', flex: '1 1 240px' }}>
                    <span className="faint" style={{ marginRight: 6 }}>B 方</span>
                    {t.sideB}
                  </span>
                </div>
                <RefsRow refs={t.refs} onLocate={props.onLocateRef} />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 4 用户群体 */}
      <Section index={4} title="用户群体" hint={`${result.audienceSegments.length} 个`}>
        {result.audienceSegments.length === 0 ? (
          <Empty>当前样本无法可靠区分用户群体</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {result.audienceSegments.map((s, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <strong>{s.name}</strong>
                <div>
                  <span className="faint" style={{ marginRight: 6 }}>关注 / 需要</span>
                  {s.need}
                </div>
                <div>
                  <span className="faint" style={{ marginRight: 6 }}>行为特征</span>
                  {s.behavior}
                </div>
                <RefsRow refs={s.refs} onLocate={props.onLocateRef} emptyText="样本无法可靠区分该群体" />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 5 为什么会产生这种讨论（可能机制） */}
      <Section index={5} title="为什么会产生这种讨论" hint="可能机制，非确定因果">
        {result.mechanisms.length === 0 ? (
          <Empty>证据不足以提出机制假设（模型未强行编造）</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {result.mechanisms.map((m, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 500 }}>{m.hypothesis}</span>
                  <ConfidenceBadge value={m.confidence} />
                </div>
                <div>{m.explanation}</div>
                <RefsRow refs={m.evidenceRefs} onLocate={props.onLocateRef} emptyText="证据不足以引用具体评论" />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 6 信号 / 噪声 */}
      <Section index={6} title="信号 / 噪声" hint="信号 = 提供新事实或逻辑；噪声 = 纯情绪表态">
        {result.signalVsNoise.length === 0 ? (
          <Empty>未做信号 / 噪声区分</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {result.signalVsNoise.map((s, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
                  <span className={`tag ${s.type === 'signal' ? 'ok' : ''}`} style={{ fontSize: 11 }}>
                    {s.type === 'signal' ? '信号' : '噪声'}
                  </span>
                  <span>{s.statement}</span>
                </div>
                <div className="faint">{s.reason}</div>
                <RefsRow refs={s.refs} onLocate={props.onLocateRef} emptyText="未指向具体评论" />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 7 对内容研究意味着什么 */}
      <Section index={7} title="对内容研究意味着什么">
        {result.contentImplications.length === 0 ? (
          <Empty>证据不足以给出内容层面的含义判断</Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {result.contentImplications.map((c, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 500 }}>{c.insight}</div>
                <div>
                  <span className="faint" style={{ marginRight: 6 }}>含义</span>
                  {c.implication}
                </div>
                <RefsRow refs={c.basisRefs} onLocate={props.onLocateRef} emptyText="无直接引用（判断基于整体结构）" />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 8 可验证假设 */}
      <Section index={8} title="可验证假设" hint="假设 → 证据 → 反证 → 验证">
        {result.hypothesesToTest.length === 0 ? (
          <Empty>当前样本没有产生值得验证的假设</Empty>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {result.hypothesesToTest.map((h, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 500 }}>{h.hypothesis}</div>
                <div className="row wrap" style={{ gap: 12 }}>
                  <span>
                    <span className="faint ok" style={{ marginRight: 4 }}>支持</span>
                    {h.evidenceForRefs.length ? h.evidenceForRefs.join(' ') : '—'}
                  </span>
                  <span>
                    <span className="faint warn" style={{ marginRight: 4 }}>反证</span>
                    {h.evidenceAgainstRefs.length ? h.evidenceAgainstRefs.join(' ') : '—'}
                  </span>
                </div>
                {h.missingEvidence.length > 0 && (
                  <div>
                    <span className="faint" style={{ marginRight: 6 }}>目前缺失</span>
                    {h.missingEvidence.join('；')}
                  </div>
                )}
                <div>
                  <span className="faint" style={{ marginRight: 6 }}>验证方法</span>
                  {h.testMethod}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 9 用户需求 */}
      <Section index={9} title="用户需求">
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

      {/* 10 不确定性 */}
      <Section index={10} title="不确定性" hint="请先读这一段" tone="warn">
        <Bullets items={result.uncertainty} empty="模型未说明不确定性（这本身是风险信号）" />
      </Section>

      {/* 11 下一步研究 */}
      <Section index={11} title="下一步要采集的数据">
        <Bullets items={result.nextResearch} empty="无建议" />
      </Section>

      {/* 12 原始分析（V3.1.x 遗留分类字段，仅旧记录可见） */}
      <div className="card stack" style={{ padding: 10 }}>
        <button onClick={() => setShowLegacy((v) => !v)} style={{ alignSelf: 'flex-start' }}>
          {showLegacy ? '收起原始分析（旧版分类）' : '查看原始分析（旧版分类）'}
        </button>
        {showLegacy && (
          <>
            <div className="faint">
              以下为 V3.1.x 分类式输出（主题 / 支持 / 反对 / 发现）。V3.2.0 起由研究字段替代；
              旧记录按遗留数据如实展示，绝不回推。
            </div>
            {legacyItems.length > 0 ? (
              <Bullets items={legacyItems} empty="无" />
            ) : legacy.facts && legacy.facts.length > 0 ? (
              <Bullets items={legacy.facts} empty="无" />
            ) : (
              <Empty>该记录没有遗留分类数据（V3.2.0 新输出由上方研究字段承担）。</Empty>
            )}
          </>
        )}
      </div>

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
