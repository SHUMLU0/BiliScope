export interface CollectorInput {
  /** 业务主键（uid / bvid / 关键词 等） */
  targetId: string;
  /** 可选上下文，例如上一次快照时间 */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CollectorOk<T> {
  ok: true;
  data: T[];
  /** 是否本次触发了网络调用（用于区分缓存命中） */
  fetched: boolean;
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