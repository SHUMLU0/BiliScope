# BiliScope V3.1.0 — 工程规格（Research Workspace）

> 本文件是 V3.1.0 的**有效工程规格**（Single Source of Truth）。
> V0.1 原始规格已完整归档至文末「附录 A」，仅作历史追溯，**不再约束当前实现**。
> 规格与实现冲突时，以「已实现且被测试锁定」的事实为准；本文件只做「实现层澄清」。
> 版本对齐六处：`package.json` / `extension/manifest.json` / `CHANGELOG.md` / `DEPLOYMENT.md` / `docs/development/FINAL_AUDIT.md` / `docs/development/PROGRESS.md`（当前全部 **3.1.0**）；`tests/docs/docs-consistency.test.ts` 是仓库契约，版本号一改测试立即红。

---

## 1. 项目定位（V3.1.0）

BiliScope = Bilibili 创作者研究 + 评论研究 + 内容生态分析 + AI 辅助研究工作台（Chrome MV3 扩展）。

**本地数据、不读登录态、不存 Cookie。**

V3.1.0 主线：**Research Workspace（研究工作台）** —— 把分散的采集 / 分析 / 灵感 / 实验能力收拢为一个可日常使用的工作台，并完成两项 P0 契约升级：

1. **AI 评论数据隐私化**：AI 只见匿名引用（`C001…`），真实 ID 留本地。
2. **AI 时长策略放宽**：默认 300s 空闲监控，可选不限制；**绝不删除 `AbortController`**。

不做（沿袭 V0.1）：自动剪辑、自动发布、爆款概率百分比预测、付费系统、跨平台、用户系统、云数据库、登录态采集。

---

## 2. 技术栈（强制）

- 浏览器扩展：Chrome Extension Manifest V3
- 语言：TypeScript（strict）
- UI：React 18
- 构建：Vite 5 + `@crxjs/vite-plugin`（多入口 HTML pages）
- 数据：IndexedDB（Dexie 4）
- 状态：Zustand
- 校验：Zod
- 测试：Vitest（独立 `vitest.config.ts`）
- 包管理：pnpm
- 质量：ESLint + Prettier + TypeScript 0 errors + Lint 0 warnings

**版本单一来源（V3.1.0）**：`__APP_VERSION__` 由 `package.json` 的 `version` 注入，`vite.config.ts` 与 `vitest.config.ts` **双侧 define**（vitest 用独立配置，vite 的 define 不生效），声明于 `src/types/globals.d.ts`。禁止在任何代码中硬编码版本号字符串。

---

## 3. 目录结构（当前实际）

```
BiliScope/
├─ extension/            # MV3 manifest 与静态资源
├─ src/
│  ├─ ai/                # schemas / prompts / orchestrator / adapters / failures / probe / streaming / settings
│  ├─ collectors/        # creator / video / comment / search / hot-topic
│  ├─ normalizers/       # 接口响应 → 领域模型
│  ├─ repositories/      # Dexie 读写（upsert 按业务字段变化）
│  ├─ db/                # Dexie schema 与迁移
│  ├─ models/            # Zod 领域模型（唯一真相）
│  ├─ services/          # comment-prep（匿名化抽样）/ video-bootstrap / export / 任务运行器
│  ├─ types/             # globals.d.ts（__APP_VERSION__ 环境声明）
│  ├─ utils/             # WBI 签名、MD5、HTTP、时间、日志
│  └─ ui/
│     ├─ popup/          # 弹窗：上下文识别 + 快速操作 + 最近任务
│     ├─ options/        # 设置页：Provider / 输出上限 / AI 时长策略 / Test Mode / 关于
│     ├─ pages/          # dashboard / comment / video-research / creator / search / my / idea / ...
│     ├─ components/     # TopicPanel / ExperimentPanel / DataPortPanel / CommentAIReport / ...
│     └─ content/        # content script
├─ scripts/              # 验收脚本、E2E 辅助、scan-secrets
├─ tests/                # Vitest 单元 / 集成 / 仓库契约（docs-consistency）
└─ docs/                 # SPEC.md 与 development/（PROGRESS / FINAL_AUDIT）
```

---

## 4. 数据模型

12 张表：Creator / CreatorSnapshot / Video / VideoSnapshot / Comment / CommentAnalysis / HotTopic / Idea / Topic / Experiment / CollectionTask / AIAnalysis。

硬性约定：

- 必填字段在 Zod 里 `.required()`；每表含 `createdAt / updatedAt / source`；时间戳统一 ISO-8601。
- **`AIAnalysis` = 审计记录**（完整 prompt / 原始响应 / token / finishReason / `requestType = 'probe' | 'analysis'`），**`CommentAnalysis` = 产品结果**。二者语义分离，UI 只消费产品结果。
- **失败零落库**：只有 `SUCCESS` 才写 `CommentAnalysis`；探针失败留独立审计行，主动取消不留行。
- **unknown ≠ 0**：解析不出的字段写 `null`，UI 显示 `–`，绝不回退 `Date.now()` / `0`。
- 审计回写必须按主键 `get` + `put`（`slice(-1)` 会命中探针行，`add` 主键冲突被吞 = 静默失败，禁止）。

---

## 5. 采集层契约（不变量）

- 统一 Collector 接口（collect / normalize / save），UI **禁止直接调用** Bilibili API。
- 每个 Collector 覆盖：happy path / empty / 网络失败 / malformed / 去重（业务键）/ 限流（退避）。
- **统计与抽样严格分区**：采集 N 条 → `stats.total = N` → `sample ≤ sampleLimit`；唯一允许的 slice 在 `comment-prep.ts buildSample()`；prompt 组装**禁止 slice**。
- **环境受限如实上报**：0 条且风控（`-352` / `-412` / `-509`）→ `ok: false` + `environmentLimited`，绝不显示「采集完成 0 条」。
- 裸 BV 由 `ensureVideoByBvid()` bootstrap（本地命中 0 请求），CommentCollector 绝不自己 bootstrap。
- WBI：`buildWbiQuery()` + `refreshWbi()`，失败降级未签名 → legacy。

---

## 6. AI 层规格（V3.1.0 核心）

### 6.1 统一 orchestrator

- 单一 `orchestrate()` 管线服务全部 AI 领域；评论领域入口 `orchestrateCommentAnalysis()`（含 `auditCitations` 引用审计与 `mapToCommentAnalysis` 产品映射）。
- 自动修复上限 **2 次总请求**；仅「无效 JSON / schema 不符」可修复；`TRUNCATED` 不修复。
- Provider 解析按名读真实 `baseUrl / apiKey / model`，禁止「只换名字不换端点」。

### 6.2 统一领域契约

- `src/ai/schemas.ts` 是唯一真相：DOMAIN_SCHEMAS 一处定义 → prompt / JSON Schema / Zod 三者同源，**禁止第二套 schema**。
- **反幽灵成功**：`zodToStrictJsonSchema` 全 required + Zod `.default([])` 会把无关 JSON 补成全空「成功」。防线：`DOMAIN_SHAPE_KEYS` 结构签名前置 + `.superRefine` 全空拒绝。新增领域 schema 必须同时补两处。

### 6.3 匿名引用契约（V3.1.0 P0）

- 喂给 AI 的样本条目类型**禁止**出现 `videoId / rpid / mid / midStr / uname / uid` 等任何身份字段（类型级 + 运行时双重防线）。
- AI 只见匿名引用 `ref`（`C001` 起始、3 位补零）；`ref → 真实 rpidStr` 的映射 `citationMap` **只留在本地**，绝不进入 prompt / facts / 审计 prompt 字段。
- 高赞事实块同样只带匿名 ref 投影（`{ ref, likes, excerpt }`），且**只从 sample 内**选取——AI 只能引用它真正看到的 ref，样本外的 rpid 不给 AI，也不伪装成可引用项。
- AI 结论回填 `citationMap` 后，`support / opposition` 每条论断仍可点击定位真实评论；无引用的论断显式标注。
- 审计记录保留原始请求与响应（本地），产品结果不回显身份信息。

### 6.4 AI 时长策略（V3.1.0 P0）

- `AnalyzeRequest.idleTimeoutMs` 三态语义：`undefined` = 默认 300s；`number` = UI 指定（60/120/180/300）；`null` = 不限制（不建 idle timer）。
- **`null` ≠ 不可取消**：`AbortController` 与外部 signal 始终保留——真实断连、用户取消仍必须失败。
- **Test Mode 硬归一**：orchestrator 内 `const idleTimeoutMs = openTestMode ? null : opts.idleTimeoutMs`，不依赖 UI 传参，与 `noTotalTimeout` 同层级。
- 优先级：`request.maxTokens → provider.maxTokens → (requiresMaxTokens ? fallbackMaxTokens ?? 8192 : 省略)`；默认（Auto）请求体**省略** `max_tokens`，禁止任务级硬编码复活。
- 样本 select `[60, 80, 120, 160, 200]`；`OUTPUT_LIMIT_PROVIDER`（输出超限）优先于 context-too-large；Auto 下 `OUTPUT_TRUNCATED` 文案不得提示 BiliScope 超时。

### 6.5 probe_guarded（评论分析默认）

- Probe（`max_tokens=32` / 非流式 / 非 JSON / 无评论数据）与 Main **并行**；看门 30s → 双杀 → `REQUEST_PROBE_TIMEOUT`；healthy → 取消一切人为总时长限制，Main 只由 Provider 完成 / MAX_TOKENS / 断连 / 用户取消结束。
- Main 先完成 → `probeAbort.abort('main-completed')` 是正确资源回收。
- 探针 token 不计入分析成本；探针失败留独立审计行；Main 成功回写 `meta.probe` 按主键 `get` + `put`。

### 6.6 流式与空闲超时

- 流式默认；首字节 30s 仅提示；**连续空闲达到时长策略设定值（默认 300s）无新 chunk 才 abort**；非流式 fallback 同策略。
- 优先级 `request.stream → provider.supportsStreaming → fallback`；修复请求也必须透传 `stream / onProgress / idleTimeoutMs`。
- 仅真实 `finishReason = length / MAX_TOKENS` 才 `OUTPUT_TRUNCATED`。
- **AI 失败不清空上次成功**：不 `setReport(null)`、不删库。

### 6.7 失败分层

- `failures.ts` 15 码；`classifyRequestError(e, timeoutMs?)` 是请求类异常唯一分类入口；`describeFailure()` 禁止「技术细节：空」。

---

## 7. UI 规格（V3.1.0）

### 7.1 设计原则

- 黑白 / 低饱和、数据优先、单屏最多 5 个一级区块、5 秒法则；不做炫技 dashboard，词云即合理，高频词 ≠ 因果。
- **零 inline style**（新 UI 一律走类名）；旧 UI 允许存量。
- `unknown` 一律显示 `–`。

### 7.2 页面清单（V3.1.0）

| 入口 | 职责 |
|---|---|
| `popup` | 上下文识别（当前视频 / 搜索页）+ 7 个快速操作入口 + 最近任务（`__APP_VERSION__` 版本 tag） |
| `dashboard`（研究台） | 全库 KPI（视频 / 评论 / 创作者 / AI 分析=total−probe / 快照 / 评论研究 / 近 7 日任务）+ 最近 AI 分析表 + 最近评论研究表；**只读 Dexie、禁联网**；Nav 首位 |
| `video-research`（视频库） | 最近 300 条视频、keyword 过滤（title / bvid / authorName）、4 排序（pubTime / views / likes / comments 按最新快照）、直达评论研究 |
| `comment` | 评论研究与 AI 分析主战场 |
| `idea` | 选题库（TopicPanel：竞争度四档 / upsertByName / 删除）+ 灵感 + ExperimentPanel（状态机 + Idea→实验三步） |
| `my` | 自有账号 + DataPortPanel（导出 JSON / 导入 merge / replace 二次确认） |
| `options` | Provider / 输出上限 Auto / **AI 时长策略（60/120/180/300/不限制，即时保存）** / Test Mode / 关于（版本来自 `__APP_VERSION__`） |

### 7.3 组件契约

- `TopicPanel` / `ExperimentPanel` / `DataPortPanel` 均为独立组件，页面只负责挂载与传 repo。
- `createExperimentFromIdea(idea, patch)`：hypothesis 预填、`ideaId` 关联、idea 状态 → `researching`；写结论自动 `completed`。

---

## 8. 数据导入导出（V3.1.0）

- 导出：全库 JSON，文件名 `biliscope-export-v{version}-{date}.json`，payload `version` 必须等于构建注入的 `__APP_VERSION__`（`EXPORT-VERSION-001` 锁定）。
- 导入：先 `previewImport` 如实计数 → `merge`（默认）/ `replace`（二次 confirm）。
- 导入导出不触碰 AI Key / 审计敏感字段以外的本地凭据（本就没有）。

---

## 9. 测试策略

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单元 | Vitest | Collector、Normalizer、Repository、Adapter、schemas、failures |
| 集成 | Vitest | DB 写读、AI 失败降级、orchestrate、导出导入、docs 契约 |
| TIMEOUT 行为 | Vitest + **真实 timer**（无 fake timers） | `sseTimedFetch` mock 监听 `init.signal` abort → `controller.error()`（等价真实断连）；number 场景 ~1s 触发（watchdog 1s tick） |
| 类型 | `tsc --noEmit` | 全量 0 错误（**正控验证**：写已知类型错必须 EXIT=2，防 stdout 被吞假绿） |
| Lint | ESLint | 0 errors / 0 warnings |
| Build | `vite build` → `test:dist` | dist 产物 + 严格模式无 dist 主动 exit 1 |

- 依赖 dist 的测试：`it.skipIf(!distReady)` 优雅跳过 + `pnpm test:dist` 严格模式并存。
- bundle 锚点用带 JSX 前缀字面量（`children:"统计事实"` 等），裸文本会多处命中。
- `globalThis.x = vi.fn()` 不被 restoreAllMocks 还原 → beforeEach 存原值 / afterEach 显式还原。

---

## 10. 门禁链（固定顺序）

```
typecheck → test → lint → build → test:dist → scan-secrets → verify-acceptance → git status → commit → push → CI
```

结论分级不合并：`OFFLINE PASS / INTEGRATION PASS / REAL API PASS / REAL API ENVIRONMENT LIMITED / CHROME E2E PASS`。

- 真实 Provider 未在发布环境实测时，发布说明必须标注 **REAL AI ENVIRONMENT LIMITED**（≠ FAIL，绝不冒充 real PASS）。
- Chrome E2E 本机不可自动化 → 如实报 `CHROME_E2E_ENV_LIMITED`。
- 发布审计包 `BiliScope-v{version}-audit.zip` 软目标 **300–450KB**：robocopy 暂存法（`/XD node_modules dist .git coverage .workbuddy .crxjs .chrome /XF *.zip *.log pnpm-lock.yaml .tmp-*`）→ `Compress-Archive`；`Add-Type` 被拦截禁止使用。

---

## 11. 安全

- `.gitignore` 覆盖 `.env*`、`*.key`、`*.token`、`SESSDATA`、`cookies.txt`、`dist/`、`coverage`。
- gitleaks-like 检查：`scripts/scan-secrets.mjs`（门禁必过）。
- **API Key 仅存浏览器本地存储**，绝不写入代码 / 日志 / Git / 审计包。
- 依赖审计：`pnpm audit`（CI 必跑）。
- 提交辅助文件（临时日志 / 测试脚本）在 `git add -A` 前删除；多行提交信息用 `git commit -F <file>`。

---

## 12. GitHub 发布策略

- 仓库：`https://github.com/SHUMLU0/BiliScope`（main 分支）。
- push 使用已存 PAT（`git -c credential.helper= push https://<user>:<TOKEN>@github.com/...`）；输出落盘前 token 必须替换为 `***`。
- CI 查询用 `Invoke-RestMethod` 打 GitHub Actions API（`gh` CLI 未安装）。
- tag 与 Release：删远端 tag 重建会使 Release 变 untagged + draft → PATCH `/releases/{id}` 补 `{tag_name, draft:false, prerelease:false}`。

---

## 13. 验收标准（V3.1.0）

- FEATURE-001..010 全过（Popup / Dashboard / 视频库 / 选题库 / Idea→实验 / 导入导出 / 匿名引用 / 时长策略 / 版本注入 / Nav）。
- 门禁链全绿 + `docs-consistency` 契约全绿（README / CHANGELOG / 版本三处对齐 3.1.0）。
- 结果如实写进 `docs/development/FINAL_AUDIT.md` 与 `docs/development/PROGRESS.md`。

---

## 14. 终止条件（V3.1.0 完成定义）

用户完成一次完整研究循环且全程无需读文档：

打开 B 站视频页 → Popup 识别上下文 → 一键采集评论 → 统计与匿名化抽样 → AI 分析（匿名引用、时长策略生效、可取消）→ 报告可点击定位真实评论 → 研究台总览 → 选题 / 灵感 → 实验 → 数据导出（版本号正确）→ 导入合并。

未达成的不算 V3.1.0 完成。

---

## 附录 A — V0.1 原始规格（已归档）

> **归档说明**：以下为 2026 年 V0.1 起步阶段的原始工程规格，由用户原始指令提炼。V3.1.0 起仅作历史追溯，其中的版本号、目录清单、Provider 数量（V0.1 时期）等描述**不再约束当前实现**；核心精神（本地数据、采集契约、UI 原则、门禁纪律）已并入正文对应章节并持续有效。

### A.1 项目定位

BiliScope = Bilibili 创作者研究 + 内容生态分析 + 个人内容实验工具。

V0.1 目标：**可靠的公开数据采集 + 本地结构化保存 + 基础查询/分析**，为后续 AI / 实验闭环打地基。

不做：自动剪辑、自动发布、爆款百分比预测、付费系统、跨平台、用户系统、云数据库。

### A.2 技术栈（强制）

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

### A.3 目录结构

（V0.1 时期规划：collectors / normalizers / repositories / db / ai / services / analyzers / models / utils / ui（popup / options / pages / components）/ content / background；tests 与 src 同名镜像；docs/SPEC.md 与 development/。当前实际结构见正文第 3 节。）

### A.4 数据模型（强制 schema）

12 张表（Creator / CreatorSnapshot / Video / VideoSnapshot / Comment / CommentAnalysis / HotTopic / Idea / Topic / Experiment / CollectionTask / AIAnalysis）；必填字段 `.required()`；含 `createdAt / updatedAt / source`；id 统一 cuid（V0.1 暂用 nanoid）；时间戳统一 ISO-8601。

### A.5 采集层契约

统一 Collector 接口（collect / normalize / save）；覆盖 happy path / empty / 网络失败 / malformed / 去重 / 限流（指数退避 + 持久化 retry 计数）；UI 禁止直接调用 Bilibili API。

### A.6 错误处理与可观测性

HTTP 客户端统一 `utils/http.ts`：timeout 10s、retry 3、backoff 2^n + jitter；尊重 `X-RateLimit-*`；Logger debug/info/warn/error，UI 不显示 warn 以上；CollectionTask 表记录每次任务。

### A.7 AI 层（V0.1 时期）

3 个 Provider（OpenAI-compatible / DeepSeek / Custom），Gemini 占位；统一 `AIProvider` 签名（analyze / testConnection）；Key 存 `chrome.storage.local`，绝不写入代码 / 日志 / Git；AI 输出保留 `facts / explanations / uncertainty` 三段式。（当前实现以正文第 6 节为准。）

### A.8 UI 原则

黑白/低饱和；数据优先；单屏最多 5 个一级区块；5 秒法则；不做炫技 dashboard / 词云即合理 / 高频词 ≠ 因果。

### A.9 测试策略

单元（Collector / Normalizer / Repository / Adapter）、集成（DB 写读、AI 失败降级）、类型（tsc --noEmit 全量 0 错误）、Lint（0 errors / 0 warnings）、Build（成功生成 dist）；`npm run verify` = typecheck + lint + test + build。

### A.10 门禁

每完成一个阶段必须 verify 全绿才能进入下一阶段。

### A.11 安全

`.gitignore` 覆盖 `.env*`、`*.key`、`*.token`、`SESSDATA`、`cookies.txt`、`dist/`、`coverage`；gitleaks-like 脚本 `scripts/scan-secrets.mjs`；`pnpm audit`（CI 必跑）。

### A.12 GitHub 推送策略（V0.1 时期）

环境无 gh CLI / credential 时先完成本地全部开发与 commit 历史，明确标注「GitHub 发布因缺少授权未执行」，不索要密码/Token，由用户后续自行推送。（当前已具备 PAT push 能力，见正文第 12 节。）

### A.13 验收（TEST 001-011）

按原始指令逐项跑通，结果写进 `docs/development/FINAL_AUDIT.md`；失败项必须明确说明降级方案。

### A.14 终止条件（V0.1 时期）

V0.1 = 用户打开 B 站 UP 主 / 视频页 → 插件识别 → 采集 → 本地保存 → 显示趋势 → 单视频分析 → 评论采集 → 灵感保存 → 热点查看 → 自有账号 → AI 调用（带 Key）。未达成的不算 V0.1 完成。
