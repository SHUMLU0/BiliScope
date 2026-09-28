# BiliScope V0.1 — 工程规格

> 这是从用户原始指令提炼出的工程规格。它是后续所有代码、测试、文档的单一事实来源（Single Source of Truth）。
> 与原始指令冲突时以原始指令为准；本规格仅做"实现层澄清"。

---

## 1. 项目定位

BiliScope = Bilibili 创作者研究 + 内容生态分析 + 个人内容实验工具。

V0.1 目标：**可靠的公开数据采集 + 本地结构化保存 + 基础查询/分析**，为后续 AI / 实验闭环打地基。

不做：自动剪辑、自动发布、爆款百分比预测、付费系统、跨平台、用户系统、云数据库。

---

## 2. 技术栈（强制）

- 浏览器扩展：Chrome Extension Manifest V3
- 语言：TypeScript（strict）
- UI：React 18
- 构建：Vite 5 + `@crxjs/vite-plugin`
- 数据：IndexedDB（Dexie 4）
- 状态：Zustand
- 校验：Zod
- 测试：Vitest
- 包管理：pnpm
- 质量：ESLint + Prettier + TypeScript 0 errors + Lint 0 warnings

可选：Recharts（图表）；ECharts 二选一，V0.1 先用 Recharts。

---

## 3. 目录结构

```
BiliScope/
├─ extension/
│  ├─ manifest.json
│  └─ icons/
├─ src/
│  ├─ collectors/         # 5 个 collector
│  ├─ normalizers/        # 类型规整
│  ├─ repositories/       # 数据访问层
│  ├─ db/                 # Dexie schema + version
│  ├─ ai/                  # Adapter + Service
│  ├─ services/           # 应用层服务（调度、缓存、导出/导入）
│  ├─ analyzers/          # 统计型分析（成长、标签、词频）
│  ├─ models/             # 类型 + zod schema
│  ├─ utils/              # 通用工具（http/retry/backoff/logger）
│  ├─ ui/
│  │  ├─ popup/           # 弹窗主入口
│  │  ├─ options/         # 设置页
│  │  ├─ pages/           # 6 个主功能页
│  │  └─ components/      # 共享组件
│  ├─ content/            # content script（页面注入）
│  └─ background/         # service worker
├─ tests/                 # 与 src 同名镜像测试
├─ scripts/               # 工具脚本（gitleaks-like、依赖审计）
├─ docs/
│  ├─ SPEC.md            # 本文件
│  └─ development/       # 开发过程文档（PROGRESS.md / FINAL_AUDIT.md）
├─ public/
├─ README.md
├─ LICENSE
├─ NOTICE
├─ OPEN_SOURCE_AUDIT.md
├─ ARCHITECTURE.md
├─ DATA_POLICY.md
├─ CHANGELOG.md
├─ DEVELOPMENT.md
├─ DEPLOYMENT.md
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ .eslintrc.cjs
├─ .prettierrc
└─ .gitignore
```

---

## 4. 数据模型（强制 schema）

12 张表（与原始指令 §5 一一对应）：Creator / CreatorSnapshot / Video / VideoSnapshot / Comment / CommentAnalysis / HotTopic / Idea / Topic / Experiment / CollectionTask / AIAnalysis。

每张表必须：
- 必填字段在 Zod 里 `.required()`
- 含 `createdAt` / `updatedAt` / `source`
- id 统一用 `cuid()`（crypto-random + 时间戳；V0.1 暂用 `nanoid`）
- 时间戳统一 ISO-8601

---

## 5. 采集层契约

统一接口：

```ts
interface Collector<T> {
  readonly name: string;
  collect(input: CollectorInput): Promise<CollectorResult<T>>;
  normalize(raw: unknown): T;
  save(items: T[]): Promise<void>;
}
```

每个 Collector 必须实现：
- happy path
- empty result
- 网络失败（timeout/500/network error）
- malformed response（容错）
- 重复数据（去重 by 业务键）
- 限流（指数退避 + 持久化 retry 计数）

UI **禁止直接调用** Bilibili API；必须走 Collector。

---

## 6. 错误处理与可观测性

- HTTP 客户端统一 `utils/http.ts`：timeout 10s、retry 3、backoff 2^n + jitter
- 限流：尊重 `X-RateLimit-*` 头
- Logger：`utils/logger.ts`（debug/info/warn/error，UI 不显示 warn 以上）
- CollectionTask 表记录每次任务，便于 UI 显示进度

---

## 7. AI 层

V0.1 实现 3 个 Provider（OpenAI-compatible / DeepSeek / Custom），Gemini 占位（不强制测试，因为环境无 Key）。
统一签名：

```ts
interface AIProvider {
  analyze(req: AnalyzeRequest): Promise<AnalyzeResult>;
  testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
}
```

Key 存 `chrome.storage.local`（可选）；fallback 存 `localStorage`。**绝不写入代码 / 日志 / Git**。

AI 输出必须保留 `facts / explanations / uncertainty` 三段式（与原始指令 §16 一致）。

---

## 8. UI 原则

- 黑白/低饱和
- 数据优先
- 单屏最多 5 个一级区块
- 5 秒法则：5 秒内能说清"这里在研究什么"
- 不做炫技 dashboard / 词云即合理 / 高频词 ≠ 因果

---

## 9. 测试策略

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest | Collector、Normalizer、Repository、Adapter |
| 集成 | Vitest | DB 写入/读取、AI 失败降级 |
| 类型 | tsc --noEmit | 全量 0 错误 |
| Lint | ESLint | 0 errors / 0 warnings |
| Build | vite build | 成功生成 dist |

`npm run verify` = `typecheck + lint + test + build`。

---

## 10. 门禁

每完成一个阶段必须 `npm run verify` 全绿才能进入下一阶段。

---

## 11. 安全

- `.gitignore` 必须覆盖 `.env*`、`*.key`、`*.token`、`SESSDATA`、`cookies.txt`、`dist/`、`coverage`
- gitleaks-like 检查脚本：`scripts/scan-secrets.mjs`
- 依赖审计：`pnpm audit`（CI 必跑）

---

## 12. GitHub 推送策略

由于环境无 `gh` CLI、无 git credential：

- 完成本地 git 仓库全部开发
- 写完整 commit 历史
- 在 `docs/development/FINAL_AUDIT.md` 和最终汇报里明确标注："GitHub 发布因缺少授权未执行"
- 不索要密码/Token
- 用户后续自行 `git remote add origin <url> && git push -u origin main`

---

## 13. 验收（TEST 001-011）

按原始指令 §36 逐项跑通，结果写进 `docs/development/FINAL_AUDIT.md`。失败的项必须明确说明降级方案。

---

## 14. 终止条件

V0.1 = 用户打开 B 站 UP 主 / 视频页 → 插件识别 → 采集 → 本地保存 → 显示趋势 → 单视频分析 → 评论采集 → 灵感保存 → 热点查看 → 自有账号 → AI 调用（带 Key）。

未达成的不算 V0.1 完成。