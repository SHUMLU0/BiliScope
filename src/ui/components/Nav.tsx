/**
 * 6 个 page 共用的导航。
 * 实际 href 在 chrome-extension 加载时由运行时计算。
 */

import type { ReactNode } from 'react';

export interface NavItem {
  href: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: 'creator.html', label: '账号研究' },
  { href: 'radar.html', label: '全站雷达' },
  { href: 'comment.html', label: '评论研究' },
  { href: 'my.html', label: '我的数据' },
  { href: 'hot.html', label: '热点' },
  { href: 'idea.html', label: '灵感' },
  { href: 'tasks.html', label: '任务' },
];

export function Nav({ active }: { active: string }): ReactNode {
  return (
    <nav className="nav">
      {NAV_ITEMS.map((it) => (
        <a key={it.href} href={it.href} className={active === it.href ? 'active' : ''}>
          {it.label}
        </a>
      ))}
      <a href="../options/index.html" target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', color: 'var(--fg-muted)' }}>
        设置
      </a>
    </nav>
  );
}