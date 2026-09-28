/**
 * 轻量 logger —— 避免把第三方 logger 拖进扩展产物体积。
 * UI 层不读 warn/error，仅 background / collectors 使用。
 */

type ImportMetaEnvLite = { DEV?: boolean };
const isDev: boolean =
  typeof import.meta !== 'undefined' &&
  typeof (import.meta as { env?: ImportMetaEnvLite }).env !== 'undefined' &&
  Boolean((import.meta as { env?: ImportMetaEnvLite }).env?.DEV);

export const logger = {
  debug(...args: unknown[]): void {
    if (isDev) console.info('[biliscope:debug]', ...args);
  },
  info(...args: unknown[]): void {
    console.info('[biliscope:info]', ...args);
  },
  warn(...args: unknown[]): void {
    console.warn('[biliscope:warn]', ...args);
  },
  error(...args: unknown[]): void {
    console.error('[biliscope:error]', ...args);
  },
};