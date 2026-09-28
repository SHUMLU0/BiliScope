/**
 * 导出服务：Creator / Video / Snapshot / Comment / Idea / Topic / Analysis → JSON / CSV
 */

import { db } from '@db/database';

export interface ExportPayload {
  exportedAt: string;
  version: string;
  data: Record<string, unknown[]>;
}

export async function exportAll(): Promise<ExportPayload> {
  const [creators, creatorSnapshots, videos, videoSnapshots, comments, commentAnalyses, hotTopics, ideas, topics, experiments, collectionTasks, aiAnalyses] =
    await Promise.all([
      db.creators.toArray(),
      db.creatorSnapshots.toArray(),
      db.videos.toArray(),
      db.videoSnapshots.toArray(),
      db.comments.toArray(),
      db.commentAnalyses.toArray(),
      db.hotTopics.toArray(),
      db.ideas.toArray(),
      db.topics.toArray(),
      db.experiments.toArray(),
      db.collectionTasks.toArray(),
      db.aiAnalyses.toArray(),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    version: '0.1.0',
    data: {
      creators,
      creatorSnapshots,
      videos,
      videoSnapshots,
      comments,
      commentAnalyses,
      hotTopics,
      ideas,
      topics,
      experiments,
      collectionTasks,
      aiAnalyses,
    },
  };
}

export function toJsonBlob(p: ExportPayload): Blob {
  return new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[]): string {
  if (!rows.length) return '';
  const cols = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      for (const k of Object.keys(r)) acc.add(k);
      return acc;
    }, new Set()),
  );
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  }
  return lines.join('\n');
}

export function toCsvBlob<T extends Record<string, unknown>>(rows: T[], _name: string): Blob {
  const csv = toCsv(rows);
  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}