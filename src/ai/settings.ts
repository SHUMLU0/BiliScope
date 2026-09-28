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