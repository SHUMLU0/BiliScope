import { useEffect, useState } from 'react';
import { Nav } from '../components/Nav';
import { ideaRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import type { Idea, IdeaStatus } from '@models/idea';

const STATUS_LABEL: Record<IdeaStatus, string> = {
  idea: '想法',
  researching: '调研',
  ready: '待做',
  producing: '制作中',
  published: '已发布',
  verified: '已验证',
  discarded: '丢弃',
};

const ORDER: IdeaStatus[] = [
  'idea',
  'researching',
  'ready',
  'producing',
  'published',
  'verified',
  'discarded',
];

export function IdeaPage() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [status, setStatus] = useState('');

  const refresh = async (): Promise<void> => {
    setIdeas(await ideaRepo.list());
  };

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!title.trim()) {
      setStatus('请输入标题');
      return;
    }
    const now = nowIso();
    const idea: Idea = {
      id: newId('id'),
      title: title.trim(),
      content: content.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      source: 'manual',
      status: 'idea',
      notes: '',
      createdAt: now,
      updatedAt: now,
    };
    await ideaRepo.add(idea);
    setTitle('');
    setContent('');
    setTags('');
    setStatus(`已保存：${idea.title}`);
    await refresh();
  };

  const handleStatus = async (id: string, s: IdeaStatus): Promise<void> => {
    await ideaRepo.updateStatus(id, s);
    await refresh();
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!confirm('删除这条灵感？')) return;
    await ideaRepo.remove(id);
    await refresh();
  };

  return (
    <div className="container stack">
      <h1 style={{ margin: 0 }}>灵感 & 选题</h1>
      <Nav active="idea.html" />

      <section className="card stack">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话保存灵感…" />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="可选 · 内容、上下文"
          rows={3}
        />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="可选 · 标签，逗号分隔" />
        <div className="row">
          <button className="primary" onClick={handleSave}>
            保存
          </button>
        </div>
        {status && <div className="faint">{status}</div>}
      </section>

      <section className="card stack">
        {ideas.length === 0 ? (
          <div className="empty">暂无灵感</div>
        ) : (
          <div className="stack">
            {ideas.map((i) => (
              <div key={i.id} className="card" style={{ padding: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{i.title}</strong>
                  <select value={i.status} onChange={(e) => handleStatus(i.id, e.target.value as IdeaStatus)}>
                    {ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </div>
                {i.content && <div className="muted">{i.content}</div>}
                {i.tags.length > 0 && (
                  <div className="row wrap">
                    {i.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="faint">{i.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                  <button onClick={() => handleDelete(i.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}