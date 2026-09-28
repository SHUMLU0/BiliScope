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

/**
 * 同 cached()，但额外返回是否命中缓存。
 * V0.1.2（P1-8）：调用方需要区分「本次真的采集了」和「读的是缓存」——
 * 缓存命中时不应该再往时序库里写一条 snapshot，否则时间序列会被重复点污染。
 */
export async function cachedWithMeta<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return { value: hit, hit: true };
  const v = await loader();
  cacheSet(key, v, ttlMs);
  return { value: v, hit: false };
}

export function cacheClear(): void {
  store.clear();
}