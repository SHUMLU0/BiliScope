/**
 * 安全加载 / 保存 Provider 配置。
 * 优先 chrome.storage.local，回退 localStorage（开发模式）。
 * API Key **绝不**进入源码 / 日志 / Git。
 */

import type { ProviderConfig, ProviderName } from './types';

const KEY = 'biliscope.ai.providers.v1';

interface Store {
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  activeProvider: ProviderName;
}

const EMPTY: Store = {
  providers: {},
  activeProvider: 'openai-compatible',
};

function safeGetStore(): Store {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      // 异步路径，请用 loadProvidersAsync
      return EMPTY;
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      providers: parsed.providers ?? {},
      activeProvider: parsed.activeProvider ?? 'openai-compatible',
    };
  } catch {
    return EMPTY;
  }
}

export function loadProviders(): Store {
  return safeGetStore();
}

export async function loadProvidersAsync(): Promise<Store> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const got = await chrome.storage.local.get(KEY);
      const json = got[KEY] as string | undefined;
      if (json) {
        const parsed = JSON.parse(json) as Partial<Store>;
        return {
          providers: parsed.providers ?? {},
          activeProvider: parsed.activeProvider ?? 'openai-compatible',
        };
      }
    }
  } catch {
    /* ignore */
  }
  return safeGetStore();
}

export async function saveProviders(store: Store): Promise<void> {
  const json = JSON.stringify(store);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [KEY]: json });
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(KEY, json);
  } catch {
    /* ignore */
  }
}

export async function setActiveProvider(name: ProviderName): Promise<void> {
  const s = await loadProvidersAsync();
  await saveProviders({ providers: s.providers, activeProvider: name });
}

export async function setProviderConfig(name: ProviderName, cfg: ProviderConfig): Promise<void> {
  const s = await loadProvidersAsync();
  const providers = { ...s.providers, [name]: cfg };
  await saveProviders({ providers, activeProvider: s.activeProvider });
}

export async function getActiveConfig(): Promise<ProviderConfig | null> {
  const s = await loadProvidersAsync();
  const cfg = s.providers[s.activeProvider];
  return cfg ?? null;
}

/**
 * V3.0 · 第三节：显式按名字取 Provider 配置。
 *
 * ⚠️ 修复的真实 bug：旧 `service.ts` 用
 *   `buildAdapter({ ...cfg, name: opts.provider ?? cfg.name })`
 * 只改了 `adapter.name`，**baseUrl / apiKey / model 仍来自当前 active provider**。
 * 结果是「把请求发到 A 的端点，却标称是 B」——provider 名与端点的静默错配。
 *
 * 现在改为按名字读取**真实**配置，读不到就返回 null，由调用方如实报错，
 * 绝不「借用别的 provider 的端点」。
 */
export async function getProviderConfig(name: ProviderName): Promise<ProviderConfig | null> {
  const s = await loadProvidersAsync();
  const cfg = s.providers[name];
  if (!cfg) return null;
  // 防御：配置里存的 name 与查询键不一致时，以查询键为准（避免 UI 切换残留）
  return cfg.name === name ? cfg : { ...cfg, name };
}

/** 校验配置是否「可发起真实请求」：端点与模型都必须存在，禁止 provider 名/端点错配 */
export function isValidProviderConfig(cfg: ProviderConfig | null): cfg is ProviderConfig {
  return (
    !!cfg &&
    cfg.baseUrl.trim().length > 0 &&
    cfg.apiKey.trim().length > 0 &&
    cfg.model.trim().length > 0
  );
}

export type { Store as ProviderStore };