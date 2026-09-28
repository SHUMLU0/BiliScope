/**
 * V3.0.1 · 严格验收：以最终构建产物 `dist/` 为准校验评论页渲染顺序。
 *
 * 背景：`tests/ui/ui-order.test.ts` 在 CI 的「Unit tests (offline)」阶段运行时
 * dist 尚未构建（Build 在其之后），因此默认模式会在无 dist 时**优雅跳过**。
 * 为了避免「跳过」被当成「通过」，本地 / 验收阶段必须显式进入严格模式：
 *   - 若 dist 缺失 → 本脚本直接失败（提示先 `pnpm build`）；
 *   - 若 dist 存在 → 运行 UI-ORDER-001 并对真实产物断言。
 *
 * 用法：`pnpm test:dist`（跨平台，无需 cross-env 依赖）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_DIR = resolve(ROOT, 'dist/assets/pages');
const DIST_HTML = resolve(ROOT, 'dist/src/ui/pages/comment.html');

const hasChunk =
  existsSync(PAGES_DIR) && readdirSync(PAGES_DIR).some((n) => /^comment-.*\.js$/.test(n));

if (!hasChunk || !existsSync(DIST_HTML)) {
  console.error(
    '\n[test:dist] dist 未构建或产物不完整 —— 严格验收无法进行。\n' +
      '请先执行 `pnpm build`，再运行 `pnpm test:dist`。\n' +
      '（本检查刻意失败：绝不允许「无 dist → 跳过」被当作验收通过。）\n',
  );
  process.exit(1);
}

const vitest = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const res = spawnSync(process.execPath, [vitest, 'run', 'tests/ui/ui-order.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, UI_ORDER_STRICT: '1' },
});
process.exit(res.status ?? 1);
