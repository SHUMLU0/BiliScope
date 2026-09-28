/** ISO-8601 时间戳生成 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 当前毫秒 */
export function nowMs(): number {
  return Date.now();
}

/** 把秒级时间戳转换为 ISO 字符串（B 站接口的 ctime/pubdate 多为秒） */
export function secondsToIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** 人类可读时长：带 0 填充，定长便于对齐 */
export function formatDuration(sec: number | null | undefined): string {
  // V0.1.3：未知时长显示 –，不再显示 0s（那会被误读成「真实时长是 0」）
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
  if (h > 0) return `${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
  if (m > 0) return `${pad2(m)}m ${pad2(s)}s`;
  return `${s}s`;
}

/** 人类可读整数：12345 -> "12,345" */
export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

/** 比例（0–1）格式化为百分比：0.5 -> "50.0%"；缺失 -> "–" */
export function formatPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  return `${(ratio * 100).toFixed(digits)}%`;
}