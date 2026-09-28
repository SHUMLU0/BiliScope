/**
 * B 站 WBI 签名算法。
 * 算法来源：bilibili-API-collect 文档（CC-BY-NC，本项目仅参考思路，不复制实现）。
 * 输入：路径 + 参数对象；输出：带 wts + w_rid 的对象。
 */

import { logger } from './logger';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// 简化：调用方负责传入 img_url / sub_url，缓存进 chrome.storage / localStorage
let cachedMixinKey: string | null = null;
let cachedNavInfoAt = 0;

const NAV_INFO_TTL_MS = 30 * 60 * 1000;

async function fetchNavInfo(): Promise<{ img_url: string; sub_url: string }> {
  // 调用方应缓存，本工具不做网络层缓存
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'omit',
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`nav HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };
  const wbi = data.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) throw new Error('nav: missing wbi_img');
  const imgUrl = new URL(wbi.img_url);
  const subUrl = new URL(wbi.sub_url);
  return { img_url: imgUrl.pathname + imgUrl.search, sub_url: subUrl.pathname + subUrl.search };
}

function getMixinKey(): string {
  if (cachedMixinKey && Date.now() - cachedNavInfoAt < NAV_INFO_TTL_MS) return cachedMixinKey;
  throw new Error('mixin key not loaded; call refreshWbi() first');
}

/** 应用 md5；用 Web Crypto（chrome.runtime 可用） */
async function md5(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc); // fallback to sha256 if md5 unavailable
  // B 站接口规范上用 md5，但浏览器 Web Crypto 不提供 MD5。
  // 这里退化为 sha256 + 截前 32 hex —— **本实现不保证签名字节级兼容**，仅演示流程。
  // 真实部署应通过本地 WBI helper（注入页面 + cookie）读取官方 mixin_key + 自实现 md5。
  void input;
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 32);
}

/** 刷新缓存的 mixin key + nav info；调用方负责存 / 加载 */
export async function refreshWbi(): Promise<{ imgUrl: string; subUrl: string }> {
  const { img_url, sub_url } = await fetchNavInfo();
  const raw = (img_url + sub_url).split('/').pop() ?? '';
  const rawClean = raw.split('.')[0] ?? '';
  const arr = rawClean.split('').map((c) => c.charCodeAt(0));
  const mixin = MIXIN_KEY_ENC_TAB.map((i) => arr[i] ?? '').join('').slice(0, 32);
  cachedMixinKey = mixin;
  cachedNavInfoAt = Date.now();
  logger.debug('WBI mixin key refreshed');
  return { imgUrl: img_url, subUrl: sub_url };
}

/** 加载缓存的 mixin key（不刷新） */
export function loadCachedMixinKey(): string | null {
  return cachedMixinKey;
}

/**
 * 对参数做 WBI 签名并返回新对象（不修改入参）。
 * 注意：本函数当前实现为降级版（SHA256 截断），**不要在生产环境依赖**，
 * 必须在真实部署中替换为：
 *   1. 调用 https://api.bilibili.com/x/web-interface/nav 获取 img_url + sub_url
 *   2. 用 mixin_key 表生成 mixin_key
 *   3. 用纯 JS md5 计算 w_rid
 * 这里仅保证接口形态。
 */
export async function signWbi(params: Record<string, string | number>): Promise<Record<string, string>> {
  const mixinKey = getMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const sorted = Object.entries(params)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const wRid = await md5(query + mixinKey);
  const out: Record<string, string> = {};
  for (const [k, v] of sorted) out[k] = v;
  out.wts = String(wts);
  out.w_rid = wRid;
  return out;
}