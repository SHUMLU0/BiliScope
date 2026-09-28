import { useEffect, useState } from 'react';
import { loadProvidersAsync, saveProviders, setActiveProvider } from '@ai/settings';
import { aiTestConnection } from '@ai/service';
import type { ProviderConfig, ProviderName } from '@ai/types';
import { clearAll } from '@db/database';

const PROVIDERS: ProviderName[] = ['openai-compatible', 'deepseek', 'gemini', 'custom'];
const DEFAULTS: Record<ProviderName, Partial<ProviderConfig>> = {
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com' },
  custom: { baseUrl: '' },
};

export function OptionsApp() {
  const [store, setStore] = useState<Awaited<ReturnType<typeof loadProvidersAsync>> | null>(null);
  const [active, setActive] = useState<ProviderName>('openai-compatible');
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProvidersAsync().then((s) => {
      setStore(s);
      setActive(s.activeProvider);
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
          V0.1 · MIT License · 数据来源仅 B 站公开接口。
        </p>
      </section>
    </div>
  );
}