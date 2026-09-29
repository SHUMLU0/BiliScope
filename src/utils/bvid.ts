/**
 * V3.2.1 · P0：BV 号解析统一入口。
 *
 * 为什么需要它（真实缺陷）：
 *   页面各处对 bvid 的处理各自为政 —— CommentPage 从 URL 取 `?bvid=` 原样使用，
 *   handleFetch 用 `/^BV[0-9A-Za-z]{10}$/` 校验，用户粘贴完整视频链接
 *   （`https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=...`）时
 *   两处都拒绝或产生脏数据。所有 bvid 归一化必须走本函数，禁止散落正则。
 *
 * 支持输入：
 *   - 裸 BV 号：`BV1xx411c7mD`
 *   - 完整 URL（含协议、query、分 P、spm 等任意参数）
 *   - 带 query 的短形式：`BV1xx411c7mD?p=2`
 * 返回 canonical BV 号（BV + 10 位字母数字）；解析不出返回 null —— 绝不猜测、绝不截断凑数。
 */

/** BV 号形态：BV + 10 位字母数字；前后不允许紧跟字母数字（避免从更长的 token 里截出错值） */
const BVID_PATTERN = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/;

export function parseBvid(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = BVID_PATTERN.exec(trimmed);
  return m ? m[0] : null;
}
