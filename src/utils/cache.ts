/**
 * 简易 TTL cache，仅在内存；同进程内同 key 不重复请求。
 * 跨进程持久化由 chrome.storage 完成（见 src/services/settings.ts）。
 */

interface Entry<V> {
  v: V;
  expireAt: number;
}

const store = new Map<string, Entry<unknown>>();

export function cacheGet<V>(key: string): V | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expireAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return e.v as V;
}

export function cacheSet<V>(key: string, value: V, ttlMs: number): void {
  store.set(key, { v: value, expireAt: Date.now() + ttlMs });
}

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const v = await loader();
  cacheSet(key, v, ttlMs);
  return v;
}

export function cacheClear(): void {
  store.clear();
}