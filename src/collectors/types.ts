export interface CollectorInput {
  /** 业务主键（uid / bvid / 关键词 等） */
  targetId: string;
  /** 可选上下文，例如上一次快照时间 */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 写入结果的真实计数（V0.1.2 · P1-7：UI 的「新增 N 条」必须用它，不能用 data.length） */
export interface CollectorStats {
  added: number;
  updated: number;
  unchanged: number;
}

export interface CollectorOk<T> {
  ok: true;
  data: T[];
  /** 是否本次触发了网络调用（用于区分缓存命中） */
  fetched: boolean;
  /** 持久化层的真实新增 / 更新 / 未变化计数 */
  stats?: CollectorStats;
}

export interface CollectorErr {
  ok: false;
  error: string;
  retryable: boolean;
}

export type CollectorResult<T> = CollectorOk<T> | CollectorErr;

export interface Collector<T> {
  readonly name: string;
  collect(input: CollectorInput): Promise<CollectorResult<T>>;
}