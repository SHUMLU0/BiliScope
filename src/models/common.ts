import { z } from 'zod';

/** 时间戳 ISO-8601 字符串 */
export const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'must be ISO-8601 timestamp',
});

/** 非空字符串 */
export const nonEmpty = z.string().min(1);

/** URL 字符串（不强制协议） */
export const urlLike = z.string().refine((s) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}, 'must be a URL');

/** 数据来源标签 */
export const sourceEnum = z.enum(['bili-api', 'bili-web', 'import', 'manual']);
export type Source = z.infer<typeof sourceEnum>;

/** 通用 base */
export const baseFields = z.object({
  createdAt: isoString,
  updatedAt: isoString,
  source: sourceEnum,
});