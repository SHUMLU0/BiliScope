import { useEffect, useState } from 'react';
import { loadProvidersAsync, saveProviders, setActiveProvider, loadIdleTimeoutAsync, saveIdleTimeout } from '@ai/settings';
import { aiTestConnection } from '@ai/service';
import type { ProviderConfig, ProviderName } from '@ai/types';
import { clearAll } from '@db/database';

const PROVIDERS: ProviderName[] = ['openai-compatible', 'deepseek', 'gemini', 'custom'];
const DEFAULTS: Record<ProviderName, Partial<ProviderConfig>> = {
  // V3.0.1 · P0-A：主流 Provider 默认支持流式输出（SSE），因此默认开启。
  // 若探测到端点不支持流式，可在下方自行关闭 → 回退到 120s 非流式。
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', supportsStreaming: true },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', supportsStreaming: true },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', supportsStreaming: true },
  custom: { baseUrl: '', supportsStreaming: false },
};

export function OptionsApp() {
  const [store, setStore] = useState<Awaited<ReturnType<typeof loadProvidersAsync>> | null>(null);
  const [active, setActive] = useState<ProviderName>('openai-compatible');
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // V3.1.1 · 计时二态：全局「空闲/总时长上限」偏好（null=不限制 —— 默认档）
  const [idlePref, setIdlePref] = useState<number | null>(null);
  const [idleSavedAt, setIdleSavedAt] = useState(0);

  useEffect(() => {
    loadProvidersAsync().then((s) => {
      setStore(s);
      setActive(s.activeProvider);
    });
    loadIdleTimeoutAsync().then((v) => {
      setIdlePref(v);
    });
  }, []);

  if (!store) return <div className="container">加载中…</div>;

  const cfg = store.providers[active] ?? { name: active, ...DEFAULTS[active], apiKey: '', model: '' };

  const updateCfg = (patch: Partial<ProviderConfig>) => {
    const next = {
      ...store,
      providers: { ...store.providers, [active]: { ...cfg, ...patch, name: active } as ProviderConfig },
    };
    setStore(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProviders(store);
      await setActiveProvider(active);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTest(null);
    await saveProviders(store);
    await setActiveProvider(active);
    const r = await aiTestConnection();
    setTest(r);
  };

  const handleClear = async () => {
    if (!confirm('确认清空全部本地数据？此操作不可恢复。')) return;
    await clearAll();
    alert('已清空');
  };

  // V3.1.0 · P0-AI 时长放宽：空闲超时即时保存（无需点「保存」按钮）
  const handleIdlePrefChange = async (v: string) => {
    const next = v === 'unlimited' ? null : Number(v);
    setIdlePref(next);
    await saveIdleTimeout(next);
    setIdleSavedAt(Date.now());
  };

  return (
    <div className="container stack">
      <h2 style={{ margin: 0 }}>BiliScope · 设置</h2>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>AI Provider</h3>
        <div className="row wrap">
          {PROVIDERS.map((p) => (
            <button key={p} className={p === active ? 'primary' : ''} onClick={() => setActive(p)}>
              {p}
            </button>
          ))}
        </div>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Base URL</span>
          <input
            value={cfg.baseUrl ?? ''}
            placeholder={DEFAULTS[active]?.baseUrl ?? ''}
            onChange={(e) => updateCfg({ baseUrl: e.target.value })}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">API Key（仅本地存储）</span>
          <input
            type="password"
            value={cfg.apiKey ?? ''}
            onChange={(e) => updateCfg({ apiKey: e.target.value })}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Model</span>
          <input value={cfg.model ?? ''} onChange={(e) => updateCfg({ model: e.target.value })} />
        </label>
        {/* V3.0 · 第四节：Provider 级输出上限（留空则使用任务默认值：评论 4096 / 其他 2048） */}
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">输出上限 max_tokens（留空 = 任务默认：评论 4096 / 其他 2048）</span>
          <input
            type="number"
            min={256}
            step={256}
            value={cfg.maxTokens ?? ''}
            placeholder="默认"
            onChange={(e) => {
              const v = e.target.value.trim();
              updateCfg({ maxTokens: v === '' ? undefined : Math.max(256, Number(v) || 0) });
            }}
          />
        </label>
        {/* V3.0 · 第三节：Structured Outputs 能力声明（默认关闭 = 不发 json_schema 参数） */}
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={cfg.supportsJsonSchema === true}
            onChange={(e) => updateCfg({ supportsJsonSchema: e.target.checked })}
          />
          <span className="muted">
            该 Provider 支持 Structured Outputs（`response_format: json_schema`）— 不确定请留空，将降级为 JSON mode
          </span>
        </label>
        {/* V3.0.1 · P0-A：流式输出开关。长评论分析走 SSE，进度实时可见 */}
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={cfg.supportsStreaming === true}
            onChange={(e) => updateCfg({ supportsStreaming: e.target.checked })}
          />
          <span className="muted">
            该 Provider 支持流式输出（SSE）— 推荐开启（分析进度实时可见；时长上限见下方「AI 时长策略」，默认不限制）
          </span>
        </label>
        <div className="row">
          <button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button onClick={handleTest}>测试连接</button>
        </div>
        {test && (
          <div className={test.ok ? 'tag ok' : 'tag danger'}>
            {test.ok ? `OK · ${test.latencyMs}ms` : `FAIL · ${test.message ?? ''}`}
          </div>
        )}
      </section>

      {/* V3.1.1 · 计时二态：全局空闲/总时长上限（不属于任何单个 Provider） */}
      <section className="card stack">
        <h3 style={{ margin: 0 }}>AI 时长策略</h3>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">空闲/总时长上限（连续无新响应才计时；默认不限制）</span>
          <select
            value={idlePref === null ? 'unlimited' : String(idlePref)}
            onChange={(e) => handleIdlePrefChange(e.target.value)}
          >
            <option value="unlimited">不限制（默认；仅真实断连 / 暂停 / 取消才终止）</option>
            <option value="60000">60 秒</option>
            <option value="120000">120 秒</option>
            <option value="180000">180 秒</option>
            <option value="300000">300 秒</option>
            <option value="600000">600 秒</option>
            <option value="900000">900 秒</option>
            <option value="1800000">1800 秒</option>
          </select>
        </label>
        <p className="faint" style={{ margin: 0 }}>
          只对「连续静默」计时——只要模型还在输出就永不中断。非流式请求的总时长上限跟随同一选项。
          选择「不限制」时 BiliScope 不创建任何人为计时器；分析页开启 AI Test Mode 时始终为「不限制」。
        </p>
        {idleSavedAt > 0 && <div className="tag ok">已保存</div>}
      </section>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>数据</h3>
        <p className="faint" style={{ margin: 0 }}>
          所有数据仅保存在浏览器 IndexedDB 中。可一键清空。
        </p>
        <div>
          <button onClick={handleClear} className="danger">
            清空全部数据
          </button>
        </div>
      </section>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>关于</h3>
        <p className="faint" style={{ margin: 0 }}>
          v{__APP_VERSION__} · MIT License · 数据来源仅 B 站公开接口。
        </p>
      </section>
    </div>
  );
}