import { useEffect, useState } from 'react';
import { detectPageContext } from '@content/detect';
import { CreatorCollector } from '@collectors/creator-collector';

const collector = new CreatorCollector();

export function PopupApp() {
  const [context, setContext] = useState<{ type: string; id: string } | null>(null);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    detectPageContext().then(setContext).catch(() => setContext(null));
  }, []);

  const handleAnalyzeCreator = async () => {
    if (!context || context.type !== 'creator') return;
    setStatus('采集中…');
    const r = await collector.collect({ targetId: context.id });
    if (r.ok) setStatus(`已采集：${r.data[0]?.name ?? 'ok'}`);
    else setStatus(`失败：${r.error}`);
  };

  return (
    <div style={{ width: 360, padding: 12 }} className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>BiliScope</strong>
        <span className="faint">v0.1</span>
      </div>

      {!context && <div className="empty">未识别到当前 B 站页面</div>}
      {context && (
        <div className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">当前页：</span>
            <span className="tag">{context.type}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">ID：</span>
            <span className="mono">{context.id}</span>
          </div>
          {context.type === 'creator' && (
            <button className="primary" onClick={handleAnalyzeCreator}>
              分析账号
            </button>
          )}
          {context.type === 'video' && (
            <a href={`#video=${context.id}`}>
              <button className="primary">分析视频</button>
            </a>
          )}
        </div>
      )}

      {status && <div className="faint">{status}</div>}

      <div className="row" style={{ gap: 8 }}>
        <a href="../pages/creator.html" target="_blank" rel="noreferrer">
          <button>账号研究</button>
        </a>
        <a href="../pages/radar.html" target="_blank" rel="noreferrer">
          <button>全站雷达</button>
        </a>
        <a href="../pages/comment.html" target="_blank" rel="noreferrer">
          <button>评论研究</button>
        </a>
        <a href="../pages/my.html" target="_blank" rel="noreferrer">
          <button>我的数据</button>
        </a>
        <a href="../pages/hot.html" target="_blank" rel="noreferrer">
          <button>热点</button>
        </a>
        <a href="../pages/idea.html" target="_blank" rel="noreferrer">
          <button>灵感</button>
        </a>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <a href="../options/index.html" target="_blank" rel="noreferrer" className="faint">
          设置
        </a>
      </div>
    </div>
  );
}