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
  /** 抓取页数 */
  pages?: number;
  /** B 站声明的预计总评论数（可能不可靠 / 被风控截断） */
  expectedTotal?: number;
}

/** 真实环境诊断（V0.2 · P1 诊断）：让用户知道为什么拿 / 没拿到数据 */
export interface CollectorDiagnostics {
  httpStatus?: number;
  biliCode?: number;
  message?: string;
  retryCount?: number;
  pages?: number;
  fetched?: number;
  stored?: number;
  /** 因风控 / 未登录等环境限制导致数据不完整 */
  environmentLimited?: boolean;
}

export interface CollectorOk<T> {
  ok: true;
  data: T[];
  /** 是否本次触发了网络调用（用于区分缓存命中） */
  fetched: boolean;
  /** 持久化层的真实新增 / 更新 / 未变化计数 */
  stats?: CollectorStats;
  /** 真实环境诊断 */
  diagnostics?: CollectorDiagnostics;
}

export interface CollectorErr {
  ok: false;
  error: string;
  retryable: boolean;
  /** 失败时的真实环境诊断（如风控 code、是否环境受限）；便于 UI / 测试区分「真无数据」vs「被拦截」 */
  diagnostics?: CollectorDiagnostics;
}

export type CollectorResult<T> = CollectorOk<T> | CollectorErr;

export interface Collector<T> {
  readonly name: string;
  collect(input: CollectorInput): Promise<CollectorResult<T>>;
}