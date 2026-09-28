import { useCallback, useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { collectionTaskRepo } from '@repositories/index';
import type { CollectionTask } from '@models/task';

const TYPE_LABEL: Record<string, string> = {
  creator: '账号资料',
  'creator-videos': '投稿列表',
  'video-snapshot': '视频快照',
  'video-detail': '视频详情',
  'video-comments': '评论采集',
  'hot-topic': '热点',
  search: '搜索',
  'my-data': '我的数据',
  'ai-analysis': 'AI 分析',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '排队',
  running: '进行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

function statusClass(s: string): string {
  if (s === 'success') return 'faint';
  if (s === 'partial') return 'warn';
  if (s === 'failed') return 'error';
  return 'faint';
}

export function TaskPage() {
  const [tasks, setTasks] = useState<CollectionTask[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    setTasks(await collectionTaskRepo.listRecent(100));
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
    const t = setInterval(() => {
      refresh().catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  const envLimited = tasks.filter((t) => {
    const meta = t.meta as { environmentLimited?: boolean } | undefined;
    return meta?.environmentLimited === true;
  });

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>任务 / 进度</h1>
      <Nav active="tasks.html" />

      <section className="card stack">
        <div className="faint">
          所有采集 / AI 任务的可追踪记录：状态、进度、耗时、错误与**真实环境诊断**。
          「部分成功」表示因风控 / 未登录等环境限制未取全，不视为「采集完成」。
        </div>
        <div className="row wrap">
          <div className="card" style={{ flex: '1 1 120px' }}>
            <div className="muted faint">进行中</div>
            <div className="metric">{active.length}</div>
          </div>
          <div className="card" style={{ flex: '1 1 120px' }}>
            <div className="muted faint">环境受限</div>
            <div className="metric">{envLimited.length}</div>
          </div>
          <div className="card" style={{ flex: '1 1 120px' }}>
            <div className="muted faint">总记录</div>
            <div className="metric">{tasks.length}</div>
          </div>
        </div>
        <button onClick={() => refresh()}>刷新</button>
      </section>

      <section className="card stack">
        {tasks.length === 0 ? (
          <div className="empty">暂无任务</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>目标</th>
                <th>状态</th>
                <th>进度</th>
                <th>创建时间</th>
                <th>错误 / 诊断</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const meta = t.meta as
                  | { environmentLimited?: boolean; diagnostics?: { biliCode?: number; pages?: number; fetched?: number; stored?: number } }
                  | undefined;
                return (
                  <tr key={t.id}>
                    <td>{TYPE_LABEL[t.type] ?? t.type}</td>
                    <td className="mono faint">{t.targetId}</td>
                    <td className={statusClass(t.status)}>{STATUS_LABEL[t.status] ?? t.status}</td>
                    <td>{Math.round(t.progress * 100)}%</td>
                    <td className="faint">{t.createdAt.replace('T', ' ').slice(0, 16)}</td>
                    <td className="faint" style={{ maxWidth: 320 }}>
                      {t.errorMessage && <div className="error">{t.errorMessage}</div>}
                      {meta?.diagnostics && (
                        <div className="mono" style={{ fontSize: 11 }}>
                          code={meta.diagnostics.biliCode ?? '—'} · pages={meta.diagnostics.pages ?? '—'} · fetched=
                          {meta.diagnostics.fetched ?? '—'} · stored={meta.diagnostics.stored ?? '—'}
                        </div>
                      )}
                      {meta?.environmentLimited && <div className="warn">⚠ 环境受限</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
