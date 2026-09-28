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
  /** V0.2.1：原始抓取条数（含重复页/重复 rpid），与 `unique` 分开统计 */
  fetched?: number;
  /** V0.2.1：跨页去重后的唯一条数（真正入库依据） */
  unique?: number;
}

/**
 * 真实环境诊断（V0.2 · P1 诊断）：让用户知道为什么拿 / 没拿到数据。
 * V0.2.1 新增 paginationStalled / duplicatePageDetected / paginationAdvanced / partial，
 * 使 UI 能明确区分「真的只有这么多」与「分页卡住 / 被风控截断」。
 */
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
  /** V0.2.1：cursor/页码未前进，分页被服务端"顶住"，已主动终止 */
  paginationStalled?: boolean;
  /** V0.2.1：连续两页 rpid 完全重复（服务器返回重复页） */
  duplicatePageDetected?: boolean;
  /** V0.2.1：分页确实推进过（至少拿到 2 页不同数据） */
  paginationAdvanced?: boolean;
  /** V0.2.1：因 maxPages 等安全上限提前结束，数据不完整 */
  partial?: boolean;
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