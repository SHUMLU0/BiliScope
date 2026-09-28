# 开发指南（DEVELOPMENT）

## 环境

- Node 18+（已验证 v22.22.2）
- pnpm 8+（已验证 v10.32.1）
- Git 2.x
- Chrome 120+

## 安装

```bash
pnpm install
```

## 脚本

| 脚本 | 作用 |
|---|---|
| `pnpm dev` | Vite watch 模式（开发） |
| `pnpm build` | 生产构建到 `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |
| `pnpm test` | Vitest 跑测 |
| `pnpm verify` | `typecheck + lint + test + build` |

## 加载到 Chrome

1. `pnpm build`
2. 打开 `chrome://extensions/`
3. 打开"开发者模式"
4. 点击"加载已解压的扩展程序"，选 `dist/`

## 添加新 Collector

1. 在 `src/collectors/` 新建 `XxxCollector.ts`，实现 `Collector<T>` 接口
2. 在 `src/normalizers/` 新建 `xxx.ts`
3. 在 `src/repositories/` 新建 `XxxRepo.ts`
4. 在 `tests/` 镜像新增单测
5. 跑 `pnpm verify`

## 添加新 AI Provider

1. 在 `src/ai/adapters/` 新建 `XxxAdapter.ts`
2. 在 `src/ai/registry.ts` 注册
3. 在 `src/ai/__tests__/` 加测
5. 跑 `pnpm verify`

## Commit 规范

```
feat: ...
fix: ...
refactor: ...
test: ...
docs: ...
chore: ...
```

## 发布

参见 `DEPLOYMENT.md`（V0.1 暂未生成，发布到 Chrome Web Store 需注册开发者账号）。