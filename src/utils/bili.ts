/**
 * B 站接口通用判定 + 请求来源（Referer）常量。
 *
 * V0.1.2 修复（独立验收 · P0-2 / P0-3）：
 *   - B 站风控（如 -352 风险校验、-403 无权限、412 前置校验）是 **HTTP 200 + code != 0**，
 *     不会抛异常。此前「WBI 失败降级」只在签名函数抛错时触发，等于形同虚设。
 *     这里统一给出判定函数，让调用方按业务码决定是否降级。
 *   - api.bilibili.com 多个接口要求请求来自 bilibili 域（Referer），
 *     否则直接 412。fetch 的 Referer 属于 forbidden header，只能通过 fetch 的
 *     `referrer` init 选项设置，因此这里提供统一常量 + http 层透传。
 */

/** HTTP 200 但业务上「被拦住 / 不可用」的 B 站 code */
export const BILI_BLOCKED_CODES = new Set<number>([
  -101, // 账号未登录
  -111, // csrf 校验失败
  -352, // 风控校验失败（WBI 签名错误 / IP 风险）
  -401, // 未登录 / 权限不足
  -403, // 访问权限不足
  -412, // 请求被拦截（前置校验）
  -509, // 请求过于频繁
  -799, // 请求过于频繁，请稍后再试
]);

/** 取出 B 站响应的业务码；非对象响应返回 null */
export function biliCode(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

/** 响应是否「拿不到数据」：HTTP 200 但被风控，或压根不是合法 JSON 对象 */
export function isBiliBlocked(body: unknown): boolean {
  const code = biliCode(body);
  if (code === null) return true;
  if (code === 0) return false;
  return BILI_BLOCKED_CODES.has(code);
}

/** 响应体是否带有效 data（部分接口 code=0 但 data 为 null） */
export function hasBiliData(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const data = (body as { data?: unknown }).data;
  return data !== null && data !== undefined;
}

/** 各接口的合法 Referer（浏览器只认 fetch 的 referrer 选项，不认手动设置的 Referer 头） */
export const BILI_REFERRER = {
  www: 'https://www.bilibili.com/',
  search: 'https://search.bilibili.com/',
  space: (uid: number): string => `https://space.bilibili.com/${uid}/`,
  video: (bvid: string): string => `https://www.bilibili.com/video/${bvid}`,
} as const;
