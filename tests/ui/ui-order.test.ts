/**
 * V3.0.1 · P0-3：AI 区域必须位于「统计事实」之前。
 *
 * ⚠️ 验收标准（用户强制）：**必须以最终构建产物 dist/ 为准**，
 * 不接受「源码位置已经正确」作为验收。
 *
 * 本测试直接检查 `dist/` 中评论页的构建产物：
 * 在页面级 JSX 的**渲染顺序**里，AI 区（AI 分析状态 / AI 分析报告）必须先于「统计事实」出现。
 *
 * 若 dist 尚未构建，测试会明确跳过并提示先执行 `pnpm build`（不算通过、也不算失败）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES_DIR = resolve(ROOT, 'dist/assets/pages');
const DIST_HTML = resolve(ROOT, 'dist/src/ui/pages/comment.html');

/** 找到 dist 中评论页的构建 chunk */
function findCommentChunk(): string | null {
  if (!existsSync(PAGES_DIR)) return null;
  const f = readdirSync(PAGES_DIR).find((n) => /^comment-.*\.js$/.test(n));
  return f ? resolve(PAGES_DIR, f) : null;
}

const chunk = findCommentChunk();
const distReady = chunk !== null && existsSync(DIST_HTML);

describe('UI-ORDER-001 · AI 报告位于统计事实之前（以 dist 为准）', () => {
  it('dist 构建产物存在（否则本用例无法作为验收依据）', () => {
    expect(
      distReady,
      'dist 未构建：请先执行 `pnpm build`，随后本用例才能对最终产物做顺序验收',
    ).toBe(true);
  });

  it('评论页 dist 的渲染顺序中，AI 区先于「统计事实」', () => {
    if (!distReady || !chunk) return;
    const js = readFileSync(chunk, 'utf8');

    // 页面级渲染顺序：在 bundle 里定位这些**文本节点**首次出现的偏移量。
    // 由于整页 JSX 被顺序序列化，偏移量顺序 ≈ DOM 顺序。
    //
    // ⚠️ 关键：「统计事实」在 bundle 中共出现 2 次 ——
    //   ① `CommentAIReport.tsx` 的提示句「下列结论请结合上方统计事实与原始评论核对后再使用。」（模块被提升，偏移量靠前）
    //   ② 页面内真正的统计区块标题 `children:"统计事实"`（h3）
    // 直接用 indexOf('统计事实') 会误命中 ①，导致假失败。
    // 因此这里必须锚定**区块标题**的精确字面量 `children:"统计事实"`。
    const idxAiReport = js.indexOf('children:"AI 分析结果"'); // CommentAIReport 的标题（h3）
    const idxAiStatus = js.indexOf('children:"AI 分析状态"'); // 进行中状态卡片（h3）
    const idxStats = js.indexOf('children:"统计事实"'); // 统计事实区块标题（h3）
    const idxTop = js.indexOf('children:"高赞评论 Top 5"'); // Top 评论区块标题
    const idxLocal = js.indexOf('children:["本地评论（"'); // 本地评论区块标题

    expect(idxAiReport).toBeGreaterThan(-1);
    expect(idxAiStatus).toBeGreaterThan(-1);
    expect(idxStats).toBeGreaterThan(-1);

    // ① AI 报告必须早于统计事实
    expect(idxAiReport).toBeLessThan(idxStats);
    // ② AI 状态卡片同样早于统计事实
    expect(idxAiStatus).toBeLessThan(idxStats);
    // ③ 统计事实早于高赞评论、高赞评论早于本地评论（整体顺序链）
    expect(idxStats).toBeLessThan(idxTop);
    expect(idxTop).toBeLessThan(idxLocal);
  });

  it('页面根元素顺序与 §3 规定一致：标题 → 控件卡 → AI 区 → 统计事实', () => {
    if (!distReady || !chunk) return;
    const js = readFileSync(chunk, 'utf8');

    const idxTitle = js.indexOf('评论研究'); // <h1>
    const idxFetchBtn = js.indexOf('"采集"');
    const idxAiArea = js.indexOf('children:"AI 分析状态"');
    const idxStats = js.indexOf('children:"统计事实"');

    expect(idxTitle).toBeGreaterThan(-1);
    expect(idxFetchBtn).toBeGreaterThan(-1);
    expect(idxTitle).toBeLessThan(idxFetchBtn);
    expect(idxFetchBtn).toBeLessThan(idxAiArea);
    expect(idxAiArea).toBeLessThan(idxStats);
  });
});