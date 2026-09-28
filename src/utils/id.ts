import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nano = customAlphabet(alphabet, 12);

/** 生成 12 字符 ID，前 4 位是毫秒戳的低 8 字符转 36 进制前缀，便于按时间排序 */
export function newId(prefix?: string): string {
  const ts = Date.now().toString(36).slice(-4);
  const rand = nano();
  const id = `${ts}${rand}`;
  return prefix ? `${prefix}_${id}` : id;
}

/** 仅用于生成 NOT 严格单调的临时 ID */
export function newTempId(prefix = 'tmp'): string {
  return `${prefix}_${nano()}`;
}