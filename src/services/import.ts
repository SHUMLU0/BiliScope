/**
 * 导入服务：JSON → Zod 校验 → preview → 写入。
 * 不覆盖已有数据；可选 merge / replace。
 *
 * V0.1.2（P1-5）：此前 applyImport 只做 JSON.parse + Array.isArray 就 bulkPut，
 * 等于「导入即信任」——结构不合法的脏数据会直接写进 IndexedDB，
 * 之后所有查询 / AI 分析都会踩到。现在写入前逐条 Zod 校验：
 * 非法行跳过并计数，preview 阶段就把「合法 / 非法」如实报给用户。
 */

import { z } from 'zod';
import { db } from '@db/database';
import type { ExportPayload } from './export';
import { logger } from '@utils/logger';
import { creatorSchema, creatorSnapshotSchema } from '@models/creator';
import { videoSchema, videoSnapshotSchema } from '@models/video';
import { commentSchema, commentAnalysisSchema } from '@models/comment';
import { ideaSchema, topicSchema, experimentSchema, hotTopicSchema } from '@models/idea';
import { collectionTaskSchema, aiAnalysisSchema } from '@models/task';

export type ImportMode = 'merge' | 'replace';

/** 每张导出表对应的 Zod schema */
export const IMPORT_TABLE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  creators: creatorSchema,
  creatorSnapshots: creatorSnapshotSchema,
  videos: videoSchema,
  videoSnapshots: videoSnapshotSchema,
  comments: commentSchema,
  commentAnalyses: commentAnalysisSchema,
  hotTopics: hotTopicSchema,
  ideas: ideaSchema,
  topics: topicSchema,
  experiments: experimentSchema,
  collectionTasks: collectionTaskSchema,
  aiAnalyses: aiAnalysisSchema,
};

const MAX_REPORTED_ERRORS = 5;

export interface ImportPreview {
  ok: boolean;
  payload?: ExportPayload;
  /** 每张表通过校验、可以写入的条数 */
  counts: Record<string, number>;
  /** 每张表被 Zod 拒绝的条数 */
  invalid: Record<string, number>;
  /** 前若干条具体错误，便于用户定位 */
  errors: string[];
  error?: string;
}

export interface ImportApplyResult {
  /** 实际写入条数 */
  imported: Record<string, number>;
  /** 被校验拒绝、未写入的条数 */
  skipped: Record<string, number>;
  errors: string[];
}

interface ValidatedTable {
  rows: unknown[];
  invalid: number;
  errors: string[];
}

function validateTable(name: string, rows: unknown): ValidatedTable {
  if (!Array.isArray(rows)) return { rows: [], invalid: 0, errors: [] };
  const schema = IMPORT_TABLE_SCHEMAS[name];
  if (!schema) {
    return { rows: [], invalid: rows.length, errors: [`未知表：${name}（已跳过）`] };
  }
  const valid: unknown[] = [];
  const errors: string[] = [];
  let invalid = 0;
  for (let i = 0; i < rows.length; i++) {
    const parsed = schema.safeParse(rows[i]);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      invalid++;
      if (errors.length < MAX_REPORTED_ERRORS) {
        const issue = parsed.error.issues[0];
        const path = issue?.path?.join('.') ?? '';
        errors.push(`${name}[${i}]${path ? `.${path}` : ''}: ${issue?.message ?? 'invalid'}`);
      }
    }
  }
  return { rows: valid, invalid, errors };
}

function validatePayload(p: ExportPayload): {
  tables: Record<string, unknown[]>;
  counts: Record<string, number>;
  invalid: Record<string, number>;
  errors: string[];
} {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const invalid: Record<string, number> = {};
  const errors: string[] = [];
  for (const [name, rows] of Object.entries(p.data ?? {})) {
    const v = validateTable(name, rows);
    tables[name] = v.rows;
    counts[name] = v.rows.length;
    if (v.invalid) invalid[name] = v.invalid;
    errors.push(...v.errors);
  }
  return { tables, counts, invalid, errors };
}

export async function previewImport(json: string): Promise<ImportPreview> {
  try {
    const parsed = JSON.parse(json) as ExportPayload;
    if (!parsed || typeof parsed !== 'object' || !parsed.data) {
      return { ok: false, counts: {}, invalid: {}, errors: [], error: 'invalid export payload' };
    }
    const { counts, invalid, errors } = validatePayload(parsed);
    return { ok: true, payload: parsed, counts, invalid, errors };
  } catch (e) {
    return { ok: false, counts: {}, invalid: {}, errors: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyImport(p: ExportPayload, mode: ImportMode): Promise<ImportApplyResult> {
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

  // 写入前重新校验（payload 可能来自 UI 直接传入，不保证走过 previewImport）
  const { tables, invalid, errors } = validatePayload(p);
  const imported: Record<string, number> = {};

  const put = async (name: string, table: { bulkPut: (rows: never[]) => Promise<unknown> }): Promise<void> => {
    const rows = tables[name];
    if (!rows?.length) return;
    await table.bulkPut(rows as never[]);
    imported[name] = rows.length;
  };

  await put('creators', db.creators);
  await put('creatorSnapshots', db.creatorSnapshots);
  await put('videos', db.videos);
  await put('videoSnapshots', db.videoSnapshots);
  await put('comments', db.comments);
  await put('commentAnalyses', db.commentAnalyses);
  await put('hotTopics', db.hotTopics);
  await put('ideas', db.ideas);
  await put('topics', db.topics);
  await put('experiments', db.experiments);
  await put('collectionTasks', db.collectionTasks);
  await put('aiAnalyses', db.aiAnalyses);

  logger.info(`import applied mode=${mode} imported=${JSON.stringify(imported)} skipped=${JSON.stringify(invalid)}`);
  return { imported, skipped: invalid, errors };
}
