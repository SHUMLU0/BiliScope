/**
 * 任务系统（V0.2 · P1 · Group G）。
 *
 * 把「一次采集」包成一个可追踪的 CollectionTask：状态、进度、耗时、错误、诊断。
 * 目的：
 *  - UI 的「任务 / 进度」面板能看到「正在跑什么、跑到哪、为什么失败」。
 *  - 真实环境诊断：HTTP / 业务码 / 页数 / 抓取数 / 入库数 / 是否环境受限。
 *
 * 设计：不引入队列 / worker，保持简单 —— 采集在扩展页面内串行执行，任务记录落 Dexie。
 */

import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { logger } from '@utils/logger';
import { collectionTaskRepo } from '@repositories/index';
import { collectionTaskSchema, type CollectionTask, type CollectionTaskType } from '@models/task';
import type { CollectorResult, CollectorDiagnostics } from '@collectors/types';

export interface TaskRunSummary {
  taskId: string;
  status: CollectionTask['status'];
  errorMessage?: string;
  diagnostics?: CollectorDiagnostics;
  durationMs: number;
}

/** 创建一条 pending 任务 */
export async function createTask(
  type: CollectionTaskType,
  targetId: string,
  meta?: Record<string, unknown>,
): Promise<CollectionTask> {
  const now = nowIso();
  const task = collectionTaskSchema.parse({
    id: newId('tk'),
    type,
    targetId,
    status: 'pending',
    createdAt: now,
    retryCount: 0,
    progress: 0,
    meta,
  });
  await collectionTaskRepo.add(task);
  return task;
}

/** 标记 running */
export async function markRunning(taskId: string): Promise<void> {
  await collectionTaskRepo.update(taskId, { status: 'running', startedAt: nowIso(), progress: 0.1 });
}

/** 更新进度（0–1） */
export async function updateProgress(taskId: string, progress: number): Promise<void> {
  await collectionTaskRepo.update(taskId, { progress: Math.max(0, Math.min(1, progress)) });
}

export interface TaskErrorInfo {
  message: string;
  /** 因环境限制未拿到数据（风控 / 未登录），与「真的没有数据」区分 */
  environmentLimited: boolean;
  retryable: boolean;
  diagnostics?: CollectorDiagnostics;
}

/**
 * 判断一个失败的采集结果是「真的失败」还是「环境受限」。
 * P0-D 的落点：UI 必须能明确区分二者，不能把风控拦截显示成「采集完成 0 条」。
 */
export function classifyFailure(err: { error: string; retryable: boolean; diagnostics?: CollectorDiagnostics }): TaskErrorInfo {
  const environmentLimited =
    err.diagnostics?.environmentLimited === true ||
    /-412|-509|-352|-403|风控|未登录|环境受限/.test(err.error);
  return { message: err.error, environmentLimited, retryable: err.retryable, diagnostics: err.diagnostics };
}

/**
 * 运行一个采集任务并记录全过程。
 * `runner` 返回 CollectorResult；成功 → success（或 partial：环境受限但拿到部分数据），失败 → failed。
 */
export async function runTask<T>(
  type: CollectionTaskType,
  targetId: string,
  runner: (signal: AbortSignal | undefined) => Promise<CollectorResult<T>>,
  opts: { meta?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<TaskRunSummary> {
  const task = await createTask(type, targetId, opts.meta);
  const t0 = Date.now();
  await markRunning(task.id);
  try {
    const r = await runner(opts.signal);
    const durationMs = Date.now() - t0;
    if (r.ok) {
      // 环境受限但确实拿到部分数据 → partial（让 UI 明确提示「不完整」）
      const partial = r.diagnostics?.environmentLimited === true;
      await collectionTaskRepo.update(task.id, {
        status: partial ? 'partial' : 'success',
        finishedAt: nowIso(),
        progress: 1,
        meta: { ...(opts.meta ?? {}), diagnostics: r.diagnostics, stats: r.stats },
      });
      return { taskId: task.id, status: partial ? 'partial' : 'success', diagnostics: r.diagnostics, durationMs };
    }
    const info = classifyFailure(r);
    await collectionTaskRepo.update(task.id, {
      status: 'failed',
      finishedAt: nowIso(),
      progress: 1,
      errorMessage: info.message.slice(0, 2000),
      meta: { ...(opts.meta ?? {}), diagnostics: info.diagnostics, environmentLimited: info.environmentLimited },
    });
    return { taskId: task.id, status: 'failed', errorMessage: info.message, diagnostics: info.diagnostics, durationMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`task ${type} target=${targetId} crashed: ${msg}`);
    await collectionTaskRepo.update(task.id, {
      status: 'failed',
      finishedAt: nowIso(),
      progress: 1,
      errorMessage: msg.slice(0, 2000),
    });
    return { taskId: task.id, status: 'failed', errorMessage: msg, durationMs: Date.now() - t0 };
  }
}

/** 取消任务（协作式：调用方需用 AbortController 触发实际中断） */
export async function cancelTask(taskId: string): Promise<void> {
  await collectionTaskRepo.update(taskId, { status: 'cancelled', finishedAt: nowIso() });
}
