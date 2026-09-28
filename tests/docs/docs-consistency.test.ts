/**
 * V3.0.1 · 第九 / 十节：GitHub 文档一致性测试。
 *
 * 目标：README 与「活动源码 / 实际仓库结构」始终一致，且本地链接永不 404。
 * 这些断言直接读取磁盘文件，属于「仓库契约测试」。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 收集一个 markdown 文件里的所有本地链接（去重、去锚点、去外链） */
function localLinks(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1]!;
    if (/^https?:|^mailto:|^#/.test(link)) continue;
    const p = link.split('#')[0];
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

describe('DOC · README 与版本一致性（V3.0.1 · 第八节）', () => {
  it('DOC-001: README no longer presents V0.1/V0.2/V0.3 as the current version', () => {
    const readme = read('README.md');

    // 当前版本必须显式声明为 v3.0.1
    expect(readme).toMatch(/v3\.0\.1/);
    expect(readme).toMatch(/## 当前版本/);
    expect(readme).toMatch(/V3\.0\.1 = V3\.0 可验证 AI 分析系统的稳定性 \/ 性能 \/ UI \/ 文档维护版/);

    // 「V0.1 = ...」这种把旧版本当作当前定位的写法必须消失
    expect(readme).not.toMatch(/^V0\.1\s*=/m);
    expect(readme).not.toMatch(/^V0\.2\s*=/m);
    expect(readme).not.toMatch(/^V0\.3\s*=/m);
    // 旧的「项目边界（V0.1 不做什么）」标题不得作为当前版本叙述
    expect(readme).not.toContain('项目边界（V0.1 不做什么）');
    // 旧路线图（把 V0.2/V0.3 当未来）不得再作为当前 README 的未来规划
    expect(readme).not.toMatch(/^## 路线图$/m);

    // 必需章节齐备（第八节规定结构）
    for (const heading of [
      '# BiliScope',
      '## 当前版本',
      '## 核心能力',
      '## 评论研究',
      '## AI 分析',
      '## 安装',
      '## AI 配置',
      '## 数据与隐私',
      '## 已知限制',
      '## V3.0 → V3.0.1',
      '## Project Structure',
      '## License',
    ]) {
      expect(readme).toContain(heading);
    }
  });

  it('DOC-001: README honestly states the V3.0.0 known limitations (no "all verified" claim)', () => {
    const readme = read('README.md');
    // 已知限制必须包含风控 / 环境受限 / Real Provider 依赖本地 Key —— 不得粉饰
    expect(readme).toMatch(/风控/);
    expect(readme).toMatch(/environmentLimited|环境受限/);
    expect(readme).toMatch(/API Key/);
    expect(readme).toMatch(/mock fetch/);
    // 禁止声称「全部真实验证通过」
    expect(readme).not.toMatch(/全部真实验证通过|所有测试真实通过/);
  });

  it('DOC-002: every local link in README resolves to a real file', () => {
    const readme = read('README.md');
    const links = localLinks(readme);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(ROOT, link);
      expect(existsSync(target), `README 链接失效：${link}`).toBe(true);
    }
  });

  it('DOC-002: the previously dead reference (OPEN_SOURCE_AUDIT.md) resolves', () => {
    const readme = read('README.md');
    if (readme.includes('OPEN_SOURCE_AUDIT.md')) {
      expect(existsSync(resolve(ROOT, 'OPEN_SOURCE_AUDIT.md'))).toBe(true);
    }
  });
});

describe('DOC · 仓库文档结构（V3.0.1 · 第十节）', () => {
  it('根目录只保留规定的文档，开发过程文档位于 docs/', () => {
    // 根目录保留
    for (const f of [
      'README.md',
      'CHANGELOG.md',
      'ARCHITECTURE.md',
      'DEPLOYMENT.md',
      'DATA_POLICY.md',
      'LICENSE',
      'NOTICE',
    ]) {
      expect(existsSync(resolve(ROOT, f)), `缺少根文档 ${f}`).toBe(true);
    }
    // 开发过程文档已迁移
    expect(existsSync(resolve(ROOT, 'docs/development/PROGRESS.md'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'docs/development/FINAL_AUDIT.md'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'docs/SPEC.md'))).toBe(true);
    // 旧位置不得再存在
    expect(existsSync(resolve(ROOT, 'PROGRESS.md'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'FINAL_AUDIT.md'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'SPEC.md'))).toBe(false);
  });

  it('所有 markdown 的本地链接都可解析（含 docs/ 内文件）', () => {
    const mds = [
      'README.md',
      'CHANGELOG.md',
      'ARCHITECTURE.md',
      'DEPLOYMENT.md',
      'DATA_POLICY.md',
      'OPEN_SOURCE_AUDIT.md',
      'DEVELOPMENT.md',
      'docs/SPEC.md',
      'docs/development/PROGRESS.md',
      'docs/development/FINAL_AUDIT.md',
    ];
    for (const md of mds) {
      if (!existsSync(resolve(ROOT, md))) continue;
      const dir = dirname(resolve(ROOT, md));
      for (const link of localLinks(read(md))) {
        const target = resolve(dir, link);
        expect(existsSync(target), `${md} 链接失效：${link}`).toBe(true);
      }
    }
  });
});

describe('DOC · CHANGELOG 与版本号一致（V3.0.1 · 第十二节）', () => {
  it('CHANGELOG 含 [V3.0.1] - 2026-09-28 段落及其 Fixed / Improved 明细', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/\[V3\.0\.1\] - 2026-09-28/);
    // Fixed 条目必须覆盖本轮真实修复
    expect(changelog).toMatch(/200 条原始评论|slice\(0, ?200\)/);
    expect(changelog).toMatch(/CommentAnalysis/);
    expect(changelog).toMatch(/refresh/);
    expect(changelog).toMatch(/REQUEST_FAILED/);
    expect(changelog).toMatch(/超时/);
  });

  it('版本号三处对齐为 3.0.1（package.json / manifest.json / CHANGELOG）', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const manifest = JSON.parse(read('extension/manifest.json')) as { version: string };
    expect(pkg.version).toBe('3.0.1');
    expect(manifest.version).toBe('3.0.1');
  });
});
