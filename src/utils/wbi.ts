/**
 * B 站 WBI 签名算法。
 * 算法来源：bilibili-API-collect 文档（CC-BY-NC，本项目仅参考思路，不复制实现）。
 * 流程：nav → img_url/sub_url → mixin_key（MIXIN_KEY_ENC_TAB）→ 参数排序 + wts → w_rid = MD5(query + mixin_key)
 *
 * V0.1.2 修复（独立验收 · P0-1）：
 *   1. w_rid 改为真正的 MD5（src/utils/md5.ts 纯 JS 实现）。此前用 SHA-256 截断 32 hex，
 *      与 B 站要求的 MD5 字节不等价，服务端必然判为风控。
 *   2. mixin_key 抽取修正：此前 `(img_url + sub_url).split('/').pop()` 只拿到 sub_key，
 *      丢掉了 img_key；正确做法是分别取两个文件名再拼接。
 *   3. 新增 buildWbiQuery()：签名用的 query 与最终请求 URL 的 query 由同一段代码生成，
 *      避免 encodeURIComponent 与 URLSearchParams 编码差异（空格 %20 vs +）导致签名不匹配；
 *      同时按官方实现对 value 过滤 !'()* 字符。
 */

import { logger } from './logger';
import { md5 } from './md5';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 简化：调用方负责传入 img_url / sub_url，缓存进 chrome.storage / localStorage
let cachedMixinKey: string | null = null;
let cachedNavInfoAt = 0;

const NAV_INFO_TTL_MS = 30 * 60 * 1000;

async function fetchNavInfo(): Promise<{ img_url: string; sub_url: string }> {
  // 调用方应缓存，本工具不做网络层缓存
  const res = await fetch(NAV_URL, {
    credentials: 'omit',
    headers: {
      Accept: 'application/json',
      'User-Agent': UA,
      // nav 同样有 Referer 风控（无 Referer 时部分 IP 段直接 -352）
      Referer: 'https://www.bilibili.com/',
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

/** 从 `/bfs/wbi/xxxxxxxx.png?...` 取出文件名主体（去掉目录、扩展名、query） */
function wbiKeyFromUrl(u: string): string {
  const path = u.split('?')[0] ?? '';
  const last = path.split('/').pop() ?? '';
  return last.split('.')[0] ?? '';
}

function getMixinKey(): string {
  if (cachedMixinKey && Date.now() - cachedNavInfoAt < NAV_INFO_TTL_MS) return cachedMixinKey;
  throw new Error('mixin key not loaded; call refreshWbi() first');
}

/** 刷新缓存的 mixin key + nav info；调用方负责存 / 加载 */
export async function refreshWbi(): Promise<{ imgUrl: string; subUrl: string }> {
  const { img_url, sub_url } = await fetchNavInfo();
  // 官方算法：img_key + sub_key 拼接后按 MIXIN_KEY_ENC_TAB 重排，截取前 32 位
  const raw = wbiKeyFromUrl(img_url) + wbiKeyFromUrl(sub_url);
  if (!raw) throw new Error('wbi: empty img/sub key');
  // 正常应为 32 + 32 = 64；长度异常时签名大概率无效，交给调用方的降级链路处理
  if (raw.length < 64) logger.warn(`wbi: unexpected key length ${raw.length}`);
  const mixin = MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
  cachedMixinKey = mixin;
  cachedNavInfoAt = Date.now();
  logger.debug('WBI mixin key refreshed');
  return { imgUrl: img_url, subUrl: sub_url };
}

/** 加载缓存的 mixin key（不刷新） */
export function loadCachedMixinKey(): string | null {
  return cachedMixinKey;
}

/** 仅测试用：清空 WBI 缓存 */
export function __resetWbiForTest(): void {
  cachedMixinKey = null;
  cachedNavInfoAt = 0;
}

/** 官方实现对参与签名的 value 过滤掉这些字符 */
const CHR_FILTER = /[!'()*]/g;

function sortedEntries(params: Record<string, string | number>): ReadonlyArray<readonly [string, string]> {
  return Object.entries(params)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function encodeValue(v: string): string {
  return encodeURIComponent(v.replace(CHR_FILTER, ''));
}

/**
 * 生成可直接拼到 URL 上的完整 query（含 wts + w_rid）。
 * 请求 URL 必须用这个返回值拼装，才能保证签名与请求字节一致。
 */
export async function buildWbiQuery(params: Record<string, string | number>): Promise<string> {
  const mixinKey = getMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const entries = sortedEntries({ ...params, wts });
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeValue(v)}`).join('&');
  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

/**
 * 对参数做 WBI 签名并返回新对象（不修改入参）。
 * 返回的是**未编码**的键值对，调用方若自行拼 URL 请用 buildWbiQuery() 以免编码不一致。
 */
export async function signWbi(
  params: Record<string, string | number>,
): Promise<Record<string, string>> {
  const mixinKey = getMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const entries = sortedEntries({ ...params, wts });
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeValue(v)}`).join('&');
  const wRid = md5(query + mixinKey);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = v;
  out.w_rid = wRid;
  return out;
}
