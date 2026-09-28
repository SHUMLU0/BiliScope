/**
 * 导入服务：JSON → 校验 → preview → 写入。
 * 不覆盖已有数据；可选 merge / replace。
 */

import { db } from '@db/database';
import type { ExportPayload } from './export';
import { logger } from '@utils/logger';

export type ImportMode = 'merge' | 'replace';

export interface ImportPreview {
  ok: boolean;
  payload?: ExportPayload;
  counts: Record<string, number>;
  error?: string;
}

export async function previewImport(json: string): Promise<ImportPreview> {
  try {
    const parsed = JSON.parse(json) as ExportPayload;
    if (!parsed || typeof parsed !== 'object' || !parsed.data) {
      return { ok: false, counts: {}, error: 'invalid export payload' };
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      counts[k] = Array.isArray(v) ? v.length : 0;
    }
    return { ok: true, payload: parsed, counts };
  } catch (e) {
    return { ok: false, counts: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyImport(p: ExportPayload, mode: ImportMode): Promise<void> {
  if (mode === 'replace') {
    await Promise.all([
      db.creators.clear(),
      db.creatorSnapshots.clear(),
      db.videos.clear(),
      db.videoSnapshots.clear(),
      db.comments.clear(),
      db.commentAnalyses.clear(),
      db.hotTopics.clear(),
      db.ideas.clear(),
      db.topics.clear(),
      db.experiments.clear(),
      db.collectionTasks.clear(),
      db.aiAnalyses.clear(),
    ]);
  }
  const { data } = p;
  if (data.creators?.length) await db.creators.bulkPut(data.creators as Parameters<typeof db.creators.bulkPut>[0]);
  if (data.creatorSnapshots?.length)
    await db.creatorSnapshots.bulkPut(data.creatorSnapshots as Parameters<typeof db.creatorSnapshots.bulkPut>[0]);
  if (data.videos?.length) await db.videos.bulkPut(data.videos as Parameters<typeof db.videos.bulkPut>[0]);
  if (data.videoSnapshots?.length)
    await db.videoSnapshots.bulkPut(data.videoSnapshots as Parameters<typeof db.videoSnapshots.bulkPut>[0]);
  if (data.comments?.length) await db.comments.bulkPut(data.comments as Parameters<typeof db.comments.bulkPut>[0]);
  if (data.commentAnalyses?.length)
    await db.commentAnalyses.bulkPut(data.commentAnalyses as Parameters<typeof db.commentAnalyses.bulkPut>[0]);
  if (data.hotTopics?.length)
    await db.hotTopics.bulkPut(data.hotTopics as Parameters<typeof db.hotTopics.bulkPut>[0]);
  if (data.ideas?.length) await db.ideas.bulkPut(data.ideas as Parameters<typeof db.ideas.bulkPut>[0]);
  if (data.topics?.length) await db.topics.bulkPut(data.topics as Parameters<typeof db.topics.bulkPut>[0]);
  if (data.experiments?.length)
    await db.experiments.bulkPut(data.experiments as Parameters<typeof db.experiments.bulkPut>[0]);
  if (data.collectionTasks?.length)
    await db.collectionTasks.bulkPut(data.collectionTasks as Parameters<typeof db.collectionTasks.bulkPut>[0]);
  if (data.aiAnalyses?.length)
    await db.aiAnalyses.bulkPut(data.aiAnalyses as Parameters<typeof db.aiAnalyses.bulkPut>[0]);
  logger.info(`import applied mode=${mode}`);
}