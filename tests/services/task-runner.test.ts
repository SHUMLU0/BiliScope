import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '@db/database';
import { runTask, classifyFailure, createTask, cancelTask } from '@services/task-runner';
import { collectionTaskRepo } from '@repositories/index';

beforeEach(async () => {
  await clearAll();
});

describe('task-runner (V0.2 · Group G)', () => {
  it('records success with diagnostics', async () => {
    const summary = await runTask('video-comments', 'BV1xx411c7m1', async () => ({
      ok: true as const,
      data: [{ id: 'c1' }],
      fetched: true,
      stats: { added: 1, updated: 0, unchanged: 0, pages: 1 },
      diagnostics: { pages: 1, fetched: 1, stored: 1, biliCode: 0 },
    }));
    expect(summary.status).toBe('success');
    const task = await collectionTaskRepo.get(summary.taskId);
    expect(task?.status).toBe('success');
    expect(task?.progress).toBe(1);
    expect(task?.finishedAt).toBeTruthy();
  });

  it('environment-limited but partial data → status=partial (never "success")', async () => {
    const summary = await runTask('video-comments', 'BV1xx411c7m1', async () => ({
      ok: true as const,
      data: [{ id: 'c1' }],
      fetched: true,
      stats: { added: 1, updated: 0, unchanged: 0 },
      diagnostics: { environmentLimited: true, biliCode: -412, message: '请求被拦截' },
    }));
    expect(summary.status).toBe('partial');
    expect(summary.diagnostics?.environmentLimited).toBe(true);
  });

  it('hard failure → status=failed with message', async () => {
    const summary = await runTask('video-comments', 'BV1xx411c7m1', async () => ({
      ok: false as const,
      error: 'B 站接口返回 code=-412，环境受限',
      retryable: true,
      diagnostics: { environmentLimited: true, biliCode: -412 },
    }));
    expect(summary.status).toBe('failed');
    const task = await collectionTaskRepo.get(summary.taskId);
    expect(task?.errorMessage).toMatch(/-412/);
  });

  it('classifyFailure distinguishes environment-limited vs plain error', () => {
    const env = classifyFailure({ error: 'HTTP 412', retryable: false, diagnostics: { environmentLimited: true } });
    expect(env.environmentLimited).toBe(true);
    const plain = classifyFailure({ error: 'video not found', retryable: false });
    expect(plain.environmentLimited).toBe(false);
    const txt = classifyFailure({ error: '请求被拦截 -412', retryable: true });
    expect(txt.environmentLimited).toBe(true);
  });

  it('thrown error is captured as failed, not crash', async () => {
    const summary = await runTask('search', 'kw', async () => {
      throw new Error('boom');
    });
    expect(summary.status).toBe('failed');
    expect(summary.errorMessage).toBe('boom');
  });

  it('createTask + cancelTask lifecycle', async () => {
    const t = await createTask('hot-topic', 'all');
    expect(t.status).toBe('pending');
    await cancelTask(t.id);
    expect((await collectionTaskRepo.get(t.id))!.status).toBe('cancelled');
  });
});
