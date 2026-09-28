import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// Mock chrome.* APIs for tests (popup, storage, etc.).
// chrome.storage mock also writes to localStorage so tests can inspect
// via localStorage.getItem without dealing with chrome.storage internals.
type AnyFn = (...args: unknown[]) => unknown;

const storageMock = (() => {
  return {
    get: (keys: string | string[] | Record<string, unknown>) => {
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: localStorage.getItem(keys) });
      }
      const out: Record<string, unknown> = {};
      if (Array.isArray(keys)) {
        for (const k of keys) out[k] = localStorage.getItem(k);
      } else if (keys && typeof keys === 'object') {
        for (const k of Object.keys(keys)) {
          const v = localStorage.getItem(k);
          out[k] = v ?? (keys as Record<string, unknown>)[k];
        }
      }
      return Promise.resolve(out);
    },
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        if (v === undefined || v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, String(v));
      }
      return Promise.resolve();
    },
    remove: (keys: string | string[]) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) localStorage.removeItem(k);
      return Promise.resolve();
    },
    clear: () => {
      localStorage.clear();
      return Promise.resolve();
    },
  };
})();

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: storageMock },
  runtime: {
    sendMessage: ((..._args: unknown[]) => Promise.resolve()) as AnyFn,
    onMessage: { addListener: ((..._args: unknown[]) => undefined) as AnyFn },
    getURL: (path: string) => `chrome-extension://biliscope/${path}`,
  },
  alarms: {
    create: ((..._args: unknown[]) => undefined) as AnyFn,
    clear: ((..._args: unknown[]) => Promise.resolve()) as AnyFn,
    onAlarm: { addListener: ((..._args: unknown[]) => undefined) as AnyFn },
  },
  tabs: {
    query: ((..._args: unknown[]) => Promise.resolve([])) as AnyFn,
    sendMessage: ((..._args: unknown[]) => Promise.resolve()) as AnyFn,
  },
  action: { openPopup: ((..._args: unknown[]) => Promise.resolve()) as AnyFn },
};