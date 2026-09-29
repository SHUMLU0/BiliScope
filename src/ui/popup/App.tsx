/**
 * V3.1.0 · P0：Popup 重做。
 *
 * 结构（任务书第 3 节）：
 *   头部（品牌 + 版本 + Dashboard 入口）
 *   → 当前上下文（B 站页面识别，一键直达对应研究页）
 *   → 快速操作（六入口网格）
 *   → 最近任务（collectionTasks 最近 5 条，只读）
 *   → 底部（设置）
 *
 * 版本号来自构建期 `__APP_VERSION__`（单一来源 package.json，禁止硬编码）。
 * 样式全部在 popup.css —— 禁止 inline style。
 */

import { useEffect, useState } from 'react';
import { detectPageContext, type PageContext } from '@content/detect';
import { CreatorCollector } from '@collectors/creator-collector';
import { collectionTaskRepo } from '@repositories/index';
import type { CollectionTask, CollectionTaskStatus, CollectionTaskType } from '@models/task';

const collector = new CreatorCollector();

const CONTEXT_LABEL: Record<PageContext['type'], string> = {
  creator: 'UP 主主页',
  video: '视频页',
  search: '搜索结果',
  unknown: 'B 站页面',
};

const TASK_TYPE_LABEL: Record<CollectionTaskType, string> = {
  creator: '账号采集',
  'creator-videos': '账号投稿',
  'video-snapshot': '视频快照',
  'video-detail': '视频详情',
  'video-comments': '评论采集',
  'hot-topic': '热点',
  search: '搜索',
  'my-data': '我的数据',
  'ai-analysis': 'AI 分析',
};

const STATUS_CLASS: Record<CollectionTaskStatus, string> = {
  pending: 'tag',
  running: 'tag',
  success: 'tag ok',
  partial: 'tag warn',
  failed: 'tag danger',
  cancelled: 'tag',
};

const STATUS_LABEL: Record<CollectionTaskStatus, string> = {
  pending: '排队中',
  running: '进行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

/** 相对时间（分钟级精度足够 popup 场景；解析不出显示 –，绝不编造） */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function PopupApp() {
  const [context, setContext] = useState<PageContext | null>(null);
  const [status, setStatus] = useState('');
  const [recent, setRecent] = useState<CollectionTask[]>([]);

  useEffect(() => {
    detectPageContext()
      .then(setContext)
      .catch(() => setContext(null));
    // 最近任务：只读，失败静默（popup 必须总能打开）
    collectionTaskRepo
      .listRecent(5)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const handleAnalyzeCreator = async (): Promise<void> => {
    if (!context || context.type !== 'creator') return;
    setStatus('采集中…');
    const r = await collector.collect({ targetId: context.id });
    if (r.ok) setStatus(`已采集：${r.data[0]?.name ?? 'ok'}`);
    else setStatus(`失败：${r.error}`);
  };

  // 搜索关键词是 URL 编码的；解析不出就原样显示
  const contextIdDisplay =
    context?.type === 'search' ? safeDecode(context.id) : (context?.id ?? '');

  return (
    <div className="popup-root">
      <header className="popup-header">
        <span className="brand">BiliScope</span>
        <span className="tag">v{__APP_VERSION__}</span>
        <span className="spacer" />
        <a href="../pages/dashboard.html" target="_blank" rel="noreferrer">
          <button className="primary">研究台</button>
        </a>
      </header>

      {!context && <div className="empty">未识别到当前 B 站页面</div>}

      {context && (
        <section className="card stack popup-context">
          <div className="ctx-row">
            <span className="muted">当前页</span>
            <span className="tag">{CONTEXT_LABEL[context.type]}</span>
          </div>
          <div className="ctx-row">
            <span className="muted">{context.type === 'search' ? '关键词' : 'ID'}</span>
            <span className="ctx-id">{contextIdDisplay}</span>
          </div>
          {context.type === 'video' && (
            <a href={`../pages/comment.html?bvid=${encodeURIComponent(context.id)}`} target="_blank" rel="noreferrer">
              <button className="primary">分析此视频</button>
            </a>
          )}
          {context.type === 'creator' && (
            <button className="primary" onClick={handleAnalyzeCreator}>
              采集此账号
            </button>
          )}
        </section>
      )}

      {status && <div className="faint">{status}</div>}

      <section className="popup-section">
        <span className="faint">快速操作</span>
        <div className="popup-actions">
          <a href="../pages/comment.html" target="_blank" rel="noreferrer">
            <button>评论研究</button>
          </a>
          <a href="../pages/video-research.html" target="_blank" rel="noreferrer">
            <button>视频库</button>
          </a>
          <a href="../pages/creator.html" target="_blank" rel="noreferrer">
            <button>账号研究</button>
          </a>
          <a href="../pages/radar.html" target="_blank" rel="noreferrer">
            <button>全站雷达</button>
          </a>
          <a href="../pages/hot.html" target="_blank" rel="noreferrer">
            <button>热点</button>
          </a>
          <a href="../pages/idea.html" target="_blank" rel="noreferrer">
            <button>灵感</button>
          </a>
          <a href="../pages/my.html" target="_blank" rel="noreferrer">
            <button>我的数据</button>
          </a>
        </div>
      </section>

      <section className="popup-section">
        <span className="faint">最近任务</span>
        {recent.length === 0 ? (
          <div className="empty">暂无任务记录</div>
        ) : (
          <div className="popup-recent">
            {recent.map((t) => (
              <div key={t.id} className="recent-item">
                <span className="recent-type">{TASK_TYPE_LABEL[t.type]}</span>
                <span className="recent-target">{t.targetId || '–'}</span>
                <span className={STATUS_CLASS[t.status]}>{STATUS_LABEL[t.status]}</span>
                <span className="recent-time">{relativeTime(t.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="popup-footer">
        <span className="faint">本地数据 · 不读取登录态</span>
        <a href="../options/index.html" target="_blank" rel="noreferrer" className="faint">
          设置
        </a>
      </footer>
    </div>
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
