# 更新日志（CHANGELOG）

本项目遵循 [Semantic Versioning](https://semver.org/) 规范。

## [V3.0.1] - 2026-09-28

**维护版**：`V3.0.1 = V3.0 可验证 AI 分析系统的稳定性 / 性能 / UI / 文档维护版`。

不新增研究方向、不重写采集层、不更换数据层 —— 只修复 V3.0.0 已暴露的真实缺陷，
并把 GitHub 文档整理到与源码一致。全部改动均以「源码 + 最终 dist 构建产物」双重核实。

### Fixed

- **Comment AI 错误使用 200 条原始评论**：`buildCommentAnalyzePrompt()` 自行 `ctx.comments.slice(0, 200)`，
  绕过了 `prepareCommentAnalysis()` 的 `sampleLimit=120`，把最多 200 条评论原文塞进请求体 ——
  是 AI 分析慢与 `REQUEST_FAILED` 的主要来源。现在 prompt 只接收 prepare 层产出的**受控样本**，
  prompt 构造器被禁止再做任何 `slice`。
- **CommentAnalysis 结构化结果持久化读取错误**：`mapToCommentAnalysis()` 把 `rawResponse` 写成 Provider
  原始响应，UI 却把它强转成 `CommentAIResult` 消费 —— 语义完全错位。新增
  `CommentAnalysis.analysisResult`（Zod 校验过的结构化业务结果）作为 UI 唯一可消费来源，
  `rawResponse` 明确降级为「仅供审计/排错」。
- **AI 成功后 refresh 覆盖正确 report**：AI 成功后 `refresh()` 会重新读库，用错位的 `rawResponse`
  覆盖掉内存里正确的报告。现在读取端只认 `analysisResult`，并向后兼容 V3.0.0 旧记录
  （无结构化结果时显示「该分析为旧版本记录…请重新分析」，**绝不猜测**）。
- **REQUEST_FAILED 诊断不具体**：所有请求异常一律写成 `REQUEST_FAILED`，用户无法自助修复。
  新增分类：`REQUEST_TIMEOUT / REQUEST_HTTP_ERROR / REQUEST_NETWORK_ERROR / REQUEST_RATE_LIMITED /
  REQUEST_CONTEXT_TOO_LARGE / REQUEST_PROVIDER_ERROR`。`AbortError` → `REQUEST_TIMEOUT`；
  HTTP 413 / 400+过大 → `输入内容过大：请减少 AI 分析样本数量`；429 → `Provider 限流`；
  模型不存在 → `Model 不存在 / 不可用`。技术细节**禁止为空**。
- **AI timeout 过短**：默认超时从 30s 提高到 **60s**（不做暴力 180s）；Provider 配置页新增
  `请求超时 timeoutMs` 选项（30s / 60s / 90s / 120s）。
- **AI 失败覆盖历史成功结果**：再次分析失败时会清空 `report`，导致用户丢失上一次成功结果。
  现在失败**不清空、不删库**，UI 明确显示「本次分析失败」+「最近一次成功分析：<时间>」。
- **长请求被总时长误判截断（流式升级）**：V3.0.0/V3.0.1 早期适配器用 `setTimeout(() => ctrl.abort(), timeoutMs)`
  包裹**整条链路**（总时长硬切断，约 30s）。120 条评论的正常分析在 >35s 后会被 Abort，
  并被错误归因为 `OUTPUT_TRUNCATED`。现改为**流式输出 + 空闲监控**：
  - OpenAI 兼容：`stream: true` + `stream_options.include_usage`，读取 SSE `data:` 分片增量拼接；
  - Gemini：`:streamGenerateContent?alt=sse`，增量拼接 `parts[].text`；
  - JSON.parse + Zod 校验**只在流接收完成后执行一次**；
  - 超时改为「首字节等待 30s 仅提示、连续 **120s 无新分片**才中止」，**总时长不再是失败条件**；
  - 空闲中止分类为 `REQUEST_TIMEOUT`，消息明确说明「连续 120 秒无新响应」；
  - **绝不发送额外探测请求，也不因探测失败杀掉真实请求**。

### Improved

- **非流式 fallback 默认超时 30s/60s → 120s**：与流式空闲上限一致，避免「支持流式就没问题、
  不支持流式就超时」的不公平差异；仍可被 `timeoutMs` 覆盖。
- **新增 Provider 能力 `supportsStreaming`**：优先级 `request.stream` → `provider.supportsStreaming`
  → 非流式 fallback；设置页新增「流式输出（SSE）」开关与说明（默认开启）。
- **流式进度 UI（真实数据，无假百分比）**：`请求模型… 18s` → `模型已开始输出 · 23s · 已接收 1,204 字符`
  → 静默 ≥15s 显示 `模型仍在输出…`；超时显示 `AI 请求超时（连续 120 秒无新响应）`。
- **`OUTPUT_TRUNCATED` 与 `REQUEST_TIMEOUT` 严格区分**：`OUTPUT_TRUNCATED` **仅在真实 `finishReason`
  表示 token 上限时**（`length` / `MAX_TOKENS`）出现；网络长静默一律归 `REQUEST_TIMEOUT`。
- **AI sample 与统计基数分离**：采集 200 条 → 统计基于全部 200 条 → AI 只分析受控样本（默认 ≤120）。
  UI 明确显示 `统计基数：200 · AI 分析样本：120`。新增抽样策略：**高赞样本 / 最新样本 / 多样性样本**。
  统计与抽样严格分区，采多少就统计多少，**不为了优化 AI 输入而减少本地采集**。
- **AI UI 前置**：结构调整为 `标题 → BV/采集/AI 分析/AI 历史 → AI 分析状态/AI 分析报告 → 统计事实 →
  高赞评论 → 本地评论`；顺序以**最终 dist 构建产物**为准验收（新增 `UI-ORDER-001`）。
- **AI 阶段状态提示**：分析期间显示真实阶段（`准备数据… / 构造分析上下文… / 请求模型… /
  模型已开始输出… / 校验结果… / 保存分析…`）与真实耗时秒数，**不使用假进度百分比**。
- **AI 输入预算可视化**：分析期间显示 `统计：N 条 · AI 样本：M 条 · AI 输入：约 XXk 字符 · 耗时：XXs`；
  超过安全阈值时提示并建议降低样本量。
- **GitHub README 与文档结构**：README 全面重写（不再是 V0.1/V0.2/V0.3 的旧文案），
  与 V3.0.1 真实能力一致；**新增「AI 流式输出与超时行为」章节**；新增「已知限制」如实说明
  风控 / 环境受限 / Real API 依赖本地 Key / Chrome 自动 E2E 可能受限；开发过程文档迁入
  `docs/development/`，规格迁入 `docs/SPEC.md`，并修复全部本地链接（仓库内 **0 死链接**）。

### Tests

新增命名测试：`AI-PERF-001`（200 条 → 统计 200 / AI 样本 ≤120）、`AI-PERF-002`（AI 样本段不泄漏样本外评论）、
`AI-STORE-001`（SUCCESS 落 `analysisResult`）、`AI-STORE-002`（refresh 后仍完整）、
`AI-STORE-003`（Provider 原始响应不被当作业务结果）、`AI-STORE-004`（失败保留旧 SUCCESS）、
`AI-TIMEOUT-001`（AbortError → REQUEST_TIMEOUT）、`AI-ERROR-001`（413 → REQUEST_CONTEXT_TOO_LARGE）、
`AI-ERROR-002`（429 → REQUEST_RATE_LIMITED）、`UI-ORDER-001`（AI 报告先于统计事实，以 dist 为准）、
`DOC-001`（README 不再以 V0.1/V0.2/V0.3 为当前版本）、`DOC-002`（README 本地链接全部有效）。
新增流式测试（`tests/ai/streaming.test.ts` + 适配器用例）：超时常量（30s / 120s / 120s）、
SSE 行解析与跨 chunk 多字节字符、空闲看门狗中止、OpenAI / Gemini 流式增量拼接、
`request.stream` 优先级、流式 `MAX_TOKENS` 不被掩盖、流式 provider error、连接测试强制非流式。

### CI

- 修复发布期发现的 CI 假失败：`UI-ORDER-001` 依赖 `dist/` 构建产物，而 CI 的「Unit tests (offline)」
  步骤运行在 Build 之前，导致硬断言失败。现改为「默认优雅跳过 + `UI_ORDER_STRICT=1` 严格模式」双形态，
  并新增 `pnpm test:dist`（无 dist 时**主动失败**，避免「跳过」冒充「通过」）；`ci.yml` 在 Build 后
  新增 `UI order acceptance (dist, strict)` 步骤，使 dist 区序验收在 CI 中真实执行。


## [V3.0.0] - 2026-09-28

**「可验证 AI 分析系统」**：不是重写，而是在已验证的 V0.2.2 采集底座之上**重建 AI 层**。
定位从「AI 能返回一段 JSON」升级为「AI 输出必须是**可验证的数据**」。

### 修复的真实缺陷（用户点名 9 项）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | AI 分析页出现 `AI 分析结果 "{\n"` | `max_tokens` 默认仅 1024 → 输出截断；`JSON.parse` 失败后 `parsed=undefined`，UI 回退用 `response.text` 当结果显示 | 任务级默认上限（评论 4096）+ 分层失败码，截断不再被当作结果展示 |
| 2 | 截断无从判断 | OpenAI adapter 未保存 `finish_reason` | `AnalyzeResponse` 新增 `finishReason/finishMessage/responseId/modelVersion/rawText/parseError/refusal` 全量上报 |
| 3 | 截断无从判断（Gemini） | Gemini adapter 未保存 `finishReason/finishMessage` | 捕获 `finishReason`/`finishMessage`/`promptFeedback.blockReason`/`responseId`/`modelVersion` |
| 4 | `JSON.parse` 成功 ≠ 符合业务 schema | 没有领域校验 | 新增 `schemas.ts`（Zod 领域契约）+ 两级校验（结构签名 + Zod 语义） |
| 5 | `SCHEMA_NOTE` 与评论 prompt 的 `support/opposition` 要求冲突 | prompt 内存在两套 schema 描述 | 删除冲突描述，`COMMENT_SCHEMA_TEXT` 与 Zod 逐字对应，**一处定义** |
| 6 | `CommentAnalysis` 从不落库（死代码） | 没有领域投影 | `mapToCommentAnalysis()` + orchestrator 在 SUCCESS 时落库 |
| 7 | UI 主要用 `<pre>` 转储 JSON | 页面直接消费 `unknown` | 新增 `CommentAIReport`，9 个固定分区 |
| 8 | Provider 覆盖只换 `adapter.name` | `buildAdapter({...cfg, name})` 导致「发到 A 端点却标称 B」 | 新增 `getProviderConfig(name)` / `resolveProviderConfig()`，按名读真实 baseUrl/apiKey/model，错配即报错 |
| 9 | AI 测试只证明「能返回 JSON」 | 测试断言过弱 | 新增 `schemas`/`failures`/`gemini-adapter`/`orchestrator` 测试；重写 `openai-adapter`/`prompts` 测试 |

### Added

- `src/ai/schemas.ts` —— 统一 AI 结果契约（`CommentAIResult` 10 字段 / `GeneralAIResult`；一个领域一份 schema，一处定义，全 Provider 共用）
- `src/ai/failures.ts` —— 分层失败码 `REQUEST_FAILED / OUTPUT_EMPTY / OUTPUT_TRUNCATED / OUTPUT_INVALID_JSON / OUTPUT_SCHEMA_INVALID / OUTPUT_REFUSAL / NO_PROVIDER / SUCCESS`
- `src/ai/json-schema.ts` —— `zodToJsonSchema` / `zodToStrictJsonSchema`（自动 `required` 全填 + `additionalProperties:false`）
- `src/ai/orchestrator.ts` —— 统一编排：prepare → prompt → provider → request → parse → Zod → **一次**自动修复 → 审计落库 → 领域落库 → 强类型返回；含 `auditCitations()` 引用可验证性审计
- `src/ui/components/CommentAIReport.tsx` —— 9 分区结构化报告 + `AIFailureNotice` 分层失败提示
- `src/ui/pages/ai-history-page.tsx` / `ai-history.tsx` / `ai-history.html` —— AI 历史审计页（时间/类型/Provider·模型/状态/finishReason/解析/tokens/耗时，可展开原始 prompt 与响应）
- 测试：`tests/ai/schemas.test.ts` / `failures.test.ts` / `gemini-adapter.test.ts` / `orchestrator.test.ts`；重写 `openai-adapter.test.ts` / `prompts.test.ts`

### Changed

- `AnalyzeRequest` 新增 `maxTokens?` / `structuredOutput?` / `jsonSchema?`；`ProviderConfig` 新增 `maxTokens?` / `supportsJsonSchema?` / `supportsJsonObject?`
- `max_tokens` 三级优先级：`request.maxTokens` → `provider.maxTokens` → 任务默认值（评论 4096 / 其他 2048；连接测试 256）
- 结构化输出降级链：`json_schema` → `json_object` → prompt 约束 + 本地 Zod（不假设所有 OpenAI 兼容服务支持同一组参数）
- 评论 prompt 重写：删除 schema 冲突；禁止「大多数用户都…」「用户普遍…」「观众一定…」「这个视频导致…」；`nextResearch` 不得伪装成结论
- `AIAnalysis` = **审计记录**（`__meta` 携带 finishReason / structuredOutput / parseOk / tokens 等）；`CommentAnalysis` = **产品结果**
- 自动修复上限 = **2 次总请求**；仅「无效 JSON」与「schema 不符」可修复，`OUTPUT_TRUNCATED` 默认不修复
- 版本号 `0.2.2` → `3.0.0`

### Fixed

- **「幽灵成功」**：`zodToStrictJsonSchema` 把字段全部 `required`，配合 Zod `.default([])` 会让 `{"ok":1}` 这类无关 JSON 被补全成「字段齐全、内容全空」的合法结果并判定成功。新增**结构签名前置校验**（必须含领域骨架字段）+ Zod `superRefine`（不得全空、必须有领域信号），二者不满足即 `OUTPUT_SCHEMA_INVALID` → 走唯一一次修复；修复仍不满足则如实失败，**绝不落 CommentAnalysis**。
- 截断响应不再在 `JSON.parse` 失败后被回退成 raw text 展示。
- Provider 名与端点静默错配。

### Security

- `scan-secrets.mjs` 通过（无密钥泄漏）；API Key 仅存在于 `chrome.storage.local` / `localStorage`，不进入源码 / 日志 / Git / 审计包。

## [Unreleased]

### Added

- 项目骨架与文档（README/LICENSE/NOTICE/ARCHITECTURE/DATA_POLICY/OPEN_SOURCE_AUDIT/CHANGELOG/DEVELOPMENT）
- `docs/SPEC.md` 工程规格
- 12 张表数据模型（types + Zod + Dexie schema）
- 5 个 Collector：Creator / Video / Comment / HotTopic / Search
- AI Service + 4 个 Adapter（OpenAI-compatible / DeepSeek / Gemini / Custom）
- UI：popup / options / 6 个功能页骨架
- content script：B 站 UP 主空间 / 视频页 / 搜索页识别
- 测试套件：Vitest，覆盖 Collector / Normalizer / Repository / Adapter
- GitHub Actions CI：typecheck + lint + test + build
- Chrome Extension Manifest V3 打包
- JSON 导入 / JSON+CSV 导出
- 安全扫描脚本 `scripts/scan-secrets.mjs`

### Known limitations

- GitHub 仓库推送因当前环境无 `gh` CLI / 无 git credential，未自动执行。
- Gemini Adapter 实现但 V0.1 不测试（环境无 Key）。

## [V0.2.2] - 2026-09-28

**「裸 BV 评论采集依赖闭环修复」**：V0.2.1 修好了评论分页协议，但评论模块仍**没有**「BV → 本地 Video 记录」的 bootstrap 流程。用户在评论页直接输入一个本地从未采过的合法 BV，采集必然失败。

### 根因

调用链是 `comment-page.tsx → handleFetch() → CommentCollector.collectComments(bvid) → videoRepo.findByBvid(bvid)`；本地没有该 Video 时**直接返回 `video not found for bvid=<BV>`**。也就是说：**评论功能对「裸 BV」完全不可用**——只有先经过 VideoCollector（UP 主投稿列表）才会存在 Video 记录。

`src/content/detect.ts` 的 `bvidToAid()` 只取 aid、不写 Video，因此不是完整修复。

复现：真实 Chrome，评论页输入 `BV1D9aA61E6v`（本地无记录）→ 报 `采集失败：video not found for bvid=BV1D9aA61E6v`。**这与评论 API / `pagination_str` / WBI 无关**，是依赖前置条件缺失。

### P0 — 依赖闭环（核心修复）

- **P0-1 新增 `src/services/video-bootstrap.ts`**：暴露 `ensureVideoByBvid(bvid, signal?)`，职责单一——确保 `bvid` 在本地有可用的**持久化** Video 记录。
  1. `videoRepo.findByBvid(bvid)` 先查本地；**命中 → 直接返回，0 次额外 `/view` 请求**（`fetched:false`）。
  2. 本地没有 → `GET https://api.bilibili.com/x/web-interface/view?bvid=<BV>`，`Referer=https://www.bilibili.com/video/<BV>`，匿名（`credentials:'omit'`）。
  3. 判码严格：HTTP/网络失败 → **保留真实错误**（`视频信息获取失败：<真实消息>`），绝不吞成「视频不存在」；`code !== 0` → `视频信息获取失败：<业务码说明>`（`-404` 稿件不存在 / `-400` 请求错误 / `62002` 不可见 / 风控码按 `BILI_BLOCKED_CODES` 标 `retryable`）；`data` 缺失 → 失败。
  4. `owner.mid` / `owner.name` → 建立**最小** Creator（`uid` / `name` / `spaceUrl`；`level` / `followers` / `following` / `videoCount` 保持 **null**，**绝不伪造统计**）；Creator 已存在则**复用其 id**。
  5. normalize → `videoRepo.upsertByBvid()` → `findByBvid()` 取回**真正存在于 Dexie 的记录**并返回。
- **P0-2 新增 `normalizeVideoDetail()`（`src/normalizers/video.ts`）**：`/view` 是**嵌套 `{data:{...}}`** 结构，且 UP 主在 `owner.mid/name/face`（列表是顶层 `mid/author`）。未强塞进列表用的 `rawVideoSchema`（那会把缺失字段默认成空串，违背「unknown ≠ 默认值」），而是单独建 schema，但**字段解析全部复用** `parsePubTimeToIso` / `parseDurationToSeconds` / `parseViews` / `parseAuthor`。结构非法（缺 `bvid`/`aid`）返回 `null`，**不写脏数据**。
- **P0-3 `CommentCollector` 改为经 bootstrap 取依赖**：`const video = await ensureVideoByBvid(bvid, signal);`。**分页逻辑一行未动**（`aid` / `pagination_str` / `seenRpidStr` / maxPages / 二级 `pn`·`ps` / diagnostics / environmentLimited 全部保留）。
- **P0-4 UI 错误分类**：`comment-page.tsx` 不再把一切失败压成「采集失败」，而是区分——① 视频元数据获取失败 → `无法获取视频信息：…`；② 评论接口风控 → `采集受阻：评论接口风控（环境受限）· …`（带 `environmentLimited` 诊断）；③ 其他 → `采集失败：…`。

### P1 — 测试与语义

- **测试 A**：bootstrap happy path（本地无 Video → 真实 view 结构 → 自动建 Creator + Video → 评论接口 → 评论入库 Dexie）。
- **测试 B**：已有 Video → **断言 `/view` 请求数 = 0**（本地命中不重复请求；连续两次调用 1 → 0）。
- **测试 C**：`{code:-404,data:null}` → `ok:false`、`metadataFailed`、**不写脏数据**、**不打评论请求**、错误明说「视频信息获取失败」而非本地「video not found」。
- **测试 D**：view 结构非法（缺 `data` / 缺 `aid` / `bvid` 格式错）→ 失败且零脏数据；非法 bvid 入参 → 零请求。
- **测试 E**：unknown 语义——`duration`/`pubdate`/`stat` 缺失时**不得伪造 0 / `Date.now()`**（`duration=null` / `pubTime=null` / `views=null`）；`duration:"03:32"` → 212s。
- **测试 F**：真实 BV `BV1D9aA61E6v` 回归——用**真实 `/view` 响应 fixture**（新增 `tests/fixtures/real/view-detail-BV1D9aA61E6v.json`，嵌套 `data` + `owner` + `stat`），并验证「同一 fixture 若外层 `code=-404` 必须失败」（证明判码真实生效，**不硬编码「永远成功」**）。
- **性能**：常规「本地已有 Video」评论路径 = **0 次额外 view**；首次遇到 BV = **恰好 1 次 view**；刷新评论不重复请求详情。

### Engineering

- 修正既有测试对 V0.2.1 行为的过时断言（原 `requires video to be in DB` 期望 `video not found`），改为断言「本地无 Video 时会自动 bootstrap，不再直接报 video not found」。
- 测试：**243 passed / 1 skipped（28 files）**（新增 `tests/services/video-bootstrap.test.ts` 19 passed）；`typecheck` / `lint`（0 error）/ `build` 全绿。
- 版本号统一：package.json / manifest.json / CHANGELOG / DEPLOYMENT / FINAL_AUDIT / PROGRESS 全部对齐 **V0.2.2**。

### 验收口径（工程门禁 ≠ 真实链路）

`typecheck / test / lint / build` 全绿仅为**工程门禁 PASS**。真实链路结果单独记录：真实 Chrome E2E（`CHROME_E2E_PASS`）/ 真实 `/view` 是否真的被访问 —— **绝不合并两种口径**，也不把 offline fixture PASS 当成 real API PASS。

### Known limitations

- 真实 Chrome E2E 需安装已构建扩展到 Chrome 并人工/脚本验证；CI 保持离线确定（`tests/smoke/**` 已剔除）。
- `normalizeVideoDetail` 不做 tag 采集（`/view` 不返回 `tag`）；`tags` 置空数组，待后续接详情标签接口。

## [V0.2.1] - 2026-09-28

**「评论采集真实性修复」**：V0.2.0 的评论链路存在 P0 级数据链路问题——真实 Chrome 打开 `BV17u411E7UK` 只能拿到极少量评论，且一级/二级分页协议用错。本次修复对齐真实协议、补齐翻页不变量与跨页去重，并以真实接口验证。

### 根因

1. **一级分页参数错误**：V0.2.0 把上一页 `next_offset` 直接当成 URL 参数 `pagination_reply` 发送。真实协议中该参数**不存在**，正确参数是 **`pagination_str`**，其值是把上一页 `cursor.pagination_reply.next_offset`（一个 JSON 字符串）**原样**包进 `{"offset":"<next_offset>"}`。参数名错 → 服务端只返回第一页，表现为「只能拿到极少量评论」。
2. **二级分页错用一级游标逻辑**：`/x/v2/reply/reply` 被当作游标分页，实际是 **`pn=1,2,3...` + `ps`（≤20）页码分页**，且不返回 `pagination_reply`。
3. **无翻页不变量**：`next_offset` 重复返回时不会停止，会反复烧请求甚至用重复数据填满档位。
4. **无跨页去重**：`normalizeCommentPage()` 只做页内去重，跨页重复靠服务器"自觉"，`fetched` 与 `unique` 未分离。

### P0 — 协议与真实性（核心修复）

- **P0-1 一级分页协议**：新增 `buildCommentMainQuery({aid, mode, paginationOffset})`，统一产出 `oid / type=1 / mode / pagination_str / plat=1 / seek_rpid='' / web_location=1315875`。**删除**错误的 `pagination_reply` URL 参数。新增纯函数 `firstPagePaginationStr()` / `nextPagePaginationStr(nextOffset)`（`{"offset":""}` / `{"offset":"<next_offset>"}`）。**协议来源**：bilibili-API-collect `docs/comment/list.md` + 真实浏览器 Network dump，非猜测。
- **P0-2 一级测试重写**：删除所有读取 `searchParams.get('pagination_reply')` 的错误假设，改为真正验证「第 1 页 `next_offset=A` → 第 2 次请求 URL 带 `pagination_str` 且含 A → 第 2 页返回不同 rpid → 最终唯一数正确」。
- **P0-3 分页前进不变量**：维护 `previousOffset`/`currentOffset`/`seenRpidStr`，命中即停——① `nextOffset===previousOffset` → 停 + `paginationStalled` + 环境受限；② 本页唯一新增 === 0 → 停；③ 连续两页 rpid 集合完全相同 → 停 + `duplicatePageDetected`；④ `is_end=true` → 正常结束；⑤ tierLimit → 正常结束；⑥ maxPages → `partial`（绝不谎称完整）。
- **P0-4 跨页去重**：Collector 维护进程级 `seenRpidStr:Set<string>`，入库前跳过已见的 `rpidStr`；`fetched`（原始）与 `unique`（去重）分离统计。
- **P0-5 二级分页修复**：`collectSubReplies` 改为 `pn` 递增 + `ps=20`，**不再读 `pagination_reply.next_offset`**，末页判据为 `replies.length < ps`；同样走 `seenRpidStr` 去重。
- **P0-6 真实 fixture**：新增 `tests/fixtures/real/comment-main-page1.json` / `comment-main-page2.json` / `comment-reply-page1.json` / `comment-reply-page2.json`，覆盖 `rpid/rpid_str/mid/mid_str/parent/root/dialog/rcount/like/ctime/member/content/cursor/pagination_reply.next_offset`，并跑通 `response → normalizer → collector → repository → Dexie` 全链路。
- **P0-7 真实 Chrome E2E（真实验证）**：先 `/x/web-interface/view?bvid=BV17u411E7UK` 取真实 aid，再 `standard=200 / depth=top / sort=time` 采集。**实测结果：`REAL_API_PASS`**——`HTTP=200 · code=0 · pages=10 · 声明总数=11695 · fetched=200 · unique=200 · paginationAdvanced=true · environmentLimited=false`（耗时 1.77s，未触发风控）。修复前只能取到个位数评论。

### P1 — 一致性与语义

- **P1-8 ID 字符串规范键**：保留 `rpid`/`mid` 兼容字段，Repository 去重 / 索引 / 关系键优先使用 `rpidStr`/`midStr`/`rootRpidStr`/`parentRpidStr`/`dialogStr`；Dexie **v3 schema** 新增上述索引（v1/v2 保留）。杜绝 JS Number 精度导致的误合并。
- **P1-9 互动字段更新语义**：静态字段不变 → `unchanged`；互动字段（`like`/`replyCount`/`location`/`vipStatus`）变化 → `updated`，且保留原 `id` / `createdAt`。
- **P1-10 未知不伪装成 0**：`num()` 区分「真实 0」/「缺失 → null」/「失败 → unknown」；UI 对 `null` 显示 `—`。

### Engineering

- 测试：**224 passed / 1 skipped（27 files）**，其中评论链路 36 passed。含第 11 条关键回归（第 1 页仅 3 条但第 2 页有数据时**不得停在 3**）。
- 修复测试基建缺陷：`globalThis.fetch` 直接赋值不被 `vi.restoreAllMocks()` 还原，导致 E2E 被 mock 污染（"幽灵失败"）；现显式保存/还原真实 `fetch`。
- `tsconfig.json` 纳入 `scripts/`，修复 `probe-real-api.ts` 的 `wts` 类型错误；ESLint 全绿。
- 版本号统一：package.json / manifest.json / CHANGELOG / DEPLOYMENT / FINAL_AUDIT / PROGRESS 全部对齐 **V0.2.1**。

### 验收口径（工程门禁 ≠ 真实链路）

`typecheck / test / lint / build / scan-secrets / verify-acceptance` 全绿仅为**工程门禁 PASS**，与真实评论链路是否打通无关。真实链路结果单独记录：**`REAL_API_PASS`**（本次）/ `REAL_API_ENV_LIMIT` / `REAL_API_FAIL` / `CHROME_E2E_PASS`，**绝不合并两种口径**。

### Known limitations

- 无登录态：极深分页与楼中楼在风控环境下可能被限制，此时标注 `environmentLimited` / `partial`，**不伪造成功**。
- 真实端到端需低风控网络环境，CI 中默认跳过（`RUN_REAL_E2E=1` 手动触发）。

## [V0.2.0] - 2026-09-28

大版本升级：从「能采集」走向「能研究」。核心是把评论、视频、账号三条数据链路做深，并补上任务系统、灵感闭环与研究结论的「事实 / 推断分离」。

### P0 — 数据链路深度（V0.1 遗留的真实缺口）

- **P0-A 评论游标分页**：顶层评论改用 `/x/v2/reply/wbi/main`，真正使用 `cursor.pagination_reply.next_offset` / `cursor.is_end` / `cursor.all_count` 翻页；`mode=2` 按时间 / `mode=3` 按热度。**移除硬编码 `pn<=3`**。
- **P0-B 楼中楼采集**：新增 `/x/v2/reply/reply?type=1&oid&root&pn&ps=`，深度模式展开 Top N（deep=30 / advanced=100）条顶层评论的二级回复；完整保留 `rootRpid` / `parentRpid` / `replyLevel`。
- **P0-C 评论字段升级**：优先使用字符串 ID（`rpidStr` / `midStr`），补全 `root` / `parent` / `dialog` / `like` / `replyCount` / `ctime` / `uname` / `content` / `level`；可选 `sex` / `vipStatus` / `location`。
- **P0-D 「真的 N 条」vs「被风控限制的 N 条」**：采集失败带 `diagnostics`（httpStatus / biliCode / pages / fetched / stored / environmentLimited）。**当 0 条且环境受限时返回 `ok:false`，绝不显示「采集完成 0 条」**。
- **P0-E 评论研究 UI**：总量 / 已采 / 顶层 / 楼中楼 / 平均点赞 / 最高点赞 / 回复率 / 时间跨度；按点赞、时间、回复数排序 + 关键词过滤；Top 评论 / 关键词。
- **P0-F 评论 AI 分析**：复用既有 Adapter，管线为 采集→清洗→去重→统计→构造上下文→分析；输出事实 / 需求 / 疑问 / 支持 / 反对，**引用具体评论 rpid**，并单独给出不确定性。**统计与 AI 推断在 UI 与提示词上严格分区**。

### P1 — 研究能力

- **视频研究**：`VideoSnapshot` 时序（首次 / 6h / 24h / 48h / 7d / 30d 六个检查点），最近邻归点算法 + 增长计算。
- **账号研究**：内容结构（分区 / 时长分布、Top 标签、发布时段）、内容变化（前后半段对比：分区迁移、平均时长差、30 天发布速率）、突破视频检测（≥ 中位数 2×，最少 5 个样本）。
- **雷达**：创作者雷达 + 生态描述（仅描述性统计，不做因果推断）。
- **灵感闭环**：热点 → 灵感 → 实验三段式，带 `sourceRef` / `ideaId` 来源回溯；灵感状态机为显式白名单（9 状态）。
- **任务 / 进度系统**：`runTask` 统一包装采集，落 Dexie；UI「任务」页展示状态 / 进度 / 诊断，区分 `success` / `partial`（环境受限但有部分数据）/ `failed`。

### Engineering

- Dexie **v2 schema**：修复评论表陈旧索引（移除已不存在的 `memberId`）。
- 新增纯函数分析层 `src/services/analytics.ts`（无 Dexie / 无网络，便于单测）。
- 新增 `src/services/`：`creator-research` / `idea-loop` / `task-runner` / `comment-prep`。
- 测试：**201 passed / 1 skipped（27 files）**（含 1 个 `RUN_REAL_E2E` 门控的真实接口用例）。
- 版本号统一：package.json / manifest.json / CHANGELOG / DEPLOYMENT / FINAL_AUDIT / PROGRESS 全部对齐 **V0.2.0**。

### Known limitations

- 无登录态：评论楼中楼 / 深分页在风控环境下可能被限制为「环境受限」，此时明确标注而非伪造成功。
- 真实 B 站端到端需低风控环境，CI 中默认跳过。

## [V0.1.4] - 2026-09-28

Chrome 实机（影视飓风）在 V0.1.3 修复归一化后**仍**显示视频「全部 0s / 当天日期」。根因是**数据迁移失败**：`videoRepo.upsertByBvid()` 只比较 `title + tags.length` 就返回 `unchanged`，历史脏记录无法被重新采集自愈。

### Fixed — P0

- **P0-1 `videoRepo.upsertByBvid()` 业务字段比较**
  - 新增 `videoBusinessChanged(a, b)`：比较 aid / creatorId / title / description / cover / pubTime / duration / category / url / authorName / authorMid / views / tags（JSON 序列化），任一不同即判定为变更
  - 旧实现只比较 `title` + `tags.length` → 历史脏数据（`pubTime=今天`、`duration=0`、`views=null`，由 V0.1.0/V0.1.2 写入）重采集时永远 `unchanged`，Chrome 长期显示「0s / 今天」
- **P0-2 更新保留首次采集时间**
  - `upsert` 更新时展开 `video` 后显式保留 `existing.createdAt`（首次采集时间）、刷新 `updatedAt`、沿用旧主键 `id`，避免把新采集时间写回 `createdAt`
- **P0-3 新增回归测试**
  - `tests/repositories/index.test.ts`：同 title+tags 但 `pubTime/duration/views` 变化 → `updated=1` + 回读字段已纠正 + `createdAt` 保留
  - 字段完全相同 → `unchanged=1`

### Known limitations

- **必须由用户在 Chrome 实机对影视飓风重新采集一次**验证脏数据被 `upsert` 自愈；本修复不依赖清空数据库（清空库是规避，不是修复）。
- 缩略图 / 视频预览等视觉项仍属 V0.2 技术债，非阻塞。

## [V0.1.3] - 2026-09-28

Chrome 实机验收（UID 946974 · 影视飓风）后最小修复：根因是"采到了数据但归一化字段映射错了"。
本轮**先读真实 API 响应**（`scripts/probe-real-api.ts` 落盘 14 份真实响应到 `tests/fixtures/real/`），再决定映射。

### Fixed — P0

- **P0-1 / P0-2 Creator 字段映射与可空化**
  - 真实 `/x/space/wbi/acc/info` 用 `fans / attention / archive_count`；新增三级来源 `/x/relation/stat`(follower/following) + `/x/space/navnum`(video)
  - 新增第三级 fallback `/x/web-interface/card`（`mid` 为字符串、`following` 为布尔）
  - `CreatorSnapshot.followers/following/videoCount/level` 全面可空；**彻底删除所有 `?? 0`**，未知一律 `null`，UI 显示 `–`
- **P0-3 VideoNormalizer 真实字段**
  - 投稿列表 `data.list.vlist[]` 用 `created`(时间戳) / `length`("12:34") / `play` / `author` / `mid`
  - `duration` 解析不出 → `null`（不再回退 0）；`pubTime` 用 `created`/`pubdate`，**绝不回退 `Date.now()`**
- **P0-4 真实 fixture 测试**：`tests/fixtures/real/arc-search-wbi.json` 验证 created→pubTime（≠今天）、length→duration、play→views、author→authorName、mid→authorMid、缺失→null
- **P0-5 VideoCollector 不再逐条 `/view`**：默认 `fetchDetails=false`，列表 `play`→初始 `VideoSnapshot`；日志 `list requests=N, detail view requests=M`（实测 M=0）
- **P0-6 Video / VideoSnapshot 拆分**：稳定字段归 Video，时变指标归 VideoSnapshot（均 `number | null`）

### Fixed — P1

- **SearchCollector 真实链路**：真实 `search/type` 的 `data.result` 是数组（非 `{video:[]}`）；端点 `/x/web-interface/wbi/search/type`→降级 `/search/type`→未签名；保留全部真实字段；Radar 显示真实 UP 名 + 播放
- **HTTP 5xx 重试修复**：旧实现 catch 中无条件 `status:undefined` 抹掉 5xx→永不重试；现 `503→503→200` 成功、`503×4` 失败
- **Import 替换原子性**：先全量 Zod 校验，任一非法则整体拒绝（旧数据不动）；全部合法才单事务 `clear+bulkPut`
- **Smoke 语义三态**：`PASS` / `PASS_WITH_ENV_LIMIT` / `FAIL`；风控失败绝不叫 PASS；新增真实 E2E 链路测试
- **版本号统一**：package.json / manifest.json / DEPLOYMENT / CHANGELOG / FINAL_AUDIT / PROGRESS 全部对齐 V0.1.3

### Known limitations

- 匿名 + 无 Cookie 环境下，`/x/space/wbi/acc/info` 与 `/x/space/wbi/arc/search` 仍可能被判风控（code=-352/-412）。已用 `/x/web-interface/card` + `/x/relation/stat` + `/x/space/navnum` 作为匿名可用的补充来源，但**真实全量视频列表在无 Cookie 时仍可能拿不全**（见 FINAL_AUDIT § 实机验收清单）。

## [V0.1.2] - 2026-09-28

独立验收第二轮：V0.1.1「工程上基本成型」，但真实 B 站链路未通过验收。
本轮只做指定修复，不做 V0.2、不重做 UI、不做架构重构。

### Fixed — P0

- **P0-1 真正实现 MD5 WBI 签名**
  - 新增 `src/utils/md5.ts`：纯 JS MD5（RFC 1321），替换掉原来的 SHA-256 截断 32 hex
  - `w_rid = MD5(sorted_query + mixin_key)`，与 B 站要求字节等价
  - 顺带修复隐藏 bug：mixin key 抽取原为 `(img_url + sub_url).split('/').pop()`，
    实际只取到 sub_key，丢了 img_key；现改为分别取两个文件名再拼接
  - 新增 `buildWbiQuery()`：签名用的 query 与最终请求 URL 的 query 同源生成，
    并按官方实现过滤 value 里的 `!'()*`
  - 校验：RFC 1321 标准向量 + Node `crypto` MD5 差分（含中文 / emoji / 10 万字符）

- **P0-2 WBI 接口失败时真正 fallback**
  - 新增 `src/utils/bili.ts`：`biliCode()` / `isBiliBlocked()` / `hasBiliData()` / `BILI_REFERRER`
  - 事实：B 站风控是 **HTTP 200 + code=-352/403/412**，不抛异常；原实现只在签名函数抛错时降级，等于形同虚设
  - CreatorCollector 与 VideoCollector 改为：只要 WBI 响应业务码不可用 / 无 data，就降级到 legacy 接口

- **P0-3 SearchCollector 真实 Chrome 请求链路**
  - `http.ts` 新增 `referrer` 透传（Referer 是 fetch 的 forbidden header，只能走 referrer init）
  - 搜索请求带 `https://search.bilibili.com/` 来源；URL 走真实 WBI 签名，签名失败回退未签名，被拦再回退一次

- **P0-4 Radar 的 UP / 播放数据不再丢失**
  - `Video` 模型新增可选 `authorName` / `authorMid` / `views`
  - 搜索结果 `creatorId` 由字面量 `search` 改为 `uid:{mid}`
  - Radar 表格 UP 列显示真实 UP 名，新增「播放」列，时长改用 `formatDuration`

### Fixed — P1

- **P1-5** Import 写入前做真实 Zod 校验：12 张表逐条 `safeParse`，非法行跳过并计数，
  `previewImport` 上报 `counts / invalid / errors`，`applyImport` 返回 `imported / skipped`
- **P1-6** 缺失数据不再伪装成 0：`CreatorSnapshot` 的 totals 改 `number | null`，
  `normalizeCreatorTotals` 返回 `null + available=false`，UI 显示 `–`
- **P1-7** 评论「新增 N 条」改用真实入库计数：`CollectorOk.stats{added,updated,unchanged}`
- **P1-8** 缓存命中不再制造采集快照：新增 `cachedWithMeta()`，命中时 `fetched=false` 且不写 snapshot
- **P1-9** HotTopic 按业务键去重：`hotTopicBusinessId(source,title)`，重复刷新只更新 rank/timestamp
- **P1-10** Smoke test 从普通 CI 分离：`vitest.config.ts` 排除 `tests/smoke/**`，
  新增 `vitest.smoke.config.ts` + `pnpm test:smoke`，CI 加 `assert-smoke-isolated.mjs` 守卫，
  smoke 改为 `workflow_dispatch` 手动触发

### Known limitations（本轮新增）

- WBI 签名**端到端成功**未能在本机证实：当前出口 IP 对 space 系列整体风控，
  **完全不需要签名的 legacy `acc/info` 同样返回 -799 / -352**（`view`、`upstat` 正常返回 0）。
  因此 -352 不属于签名算法问题；算法正确性由离线差分测试保证。

## [V0.1.1] - 2026-09-28

独立验收发现 7 项真实数据链路问题，未要求重构。V0.1.1 按最小修复原则处理：

### Fixed

- **CreatorCollector 真实接口修复**（独立验收反馈 #1, #2, #7）
  - `/x/space/acc/info` URL 缺少 `?mid={uid}` → 已补全
  - acc/info 已被 B 站弃用 → 切到 `/x/space/wbi/acc/info`，先 `refreshWbi()` + `signWbi()`，失败降级到 legacy
  - `/x/space/upstat` URL 缺少 `?mid={uid}` → 已补全
  - upstat 在无登录态可能失败 → 改为非致命，totals=0 时 creator 仍采集成功
  - collect 返回临时 ID 导致 UI refresh 查不到数据 → upsert 后用 persistedId 重新读取 Creator 再返回

- **VideoCollector WBI 接入**（独立验收反馈 #3）
  - `/x/space/wbi/arc/search` 之前未接入 WBI → 新增 `buildWbiArcSearchUrl()`，先 `refreshWbi()` + `signWbi({mid,pn,ps,order,platform,web_location,tid,keyword})`
  - WBI 失败时降级到带 wts 的请求并明确报错

- **Video normalizer duration 兼容**（独立验收反馈 #4）
  - 真实搜索数据 `duration` 是 `"MM:SS"` 字符串；archive API 是 number
  - 新增 `parseDurationToSeconds()`：支持 `number` / numeric string / `"MM:SS"` / `"HH:MM:SS"`

- **SearchCollector 真实响应结构**（独立验收反馈 #5）
  - 之前假设 archive API 字段；真实搜索响应结构不同
  - 新增 `normalizeSearchVideo` / `normalizeSearchVideoList` / `stripSearchHighlight`（剥离 `<em class="keyword">` 高亮）

- **buildCreatorAnalyzePrompt 字段错误**（独立验收反馈 #6）
  - 原 `views: v.duration` 把 duration 误当 views 喂 AI
  - 改为 `duration: v.duration`；views 数据由 snapshots 段承担

### Added

- 真实 API smoke test：`tests/smoke/real-api.test.ts`，命中 B 站真实 nav / search / view 接口
- 新增 6 个 V0.1.1 单测 case（覆盖 WBI 接入、持久化 id、duration 兼容、搜索响应结构、prompt 字段错误回归）
- 新增 `__resetWbiForTest()` 用于测试间清空 WBI 缓存

### Test

- 113/113 PASS（19 test files）
- 0 lint errors / 0 type errors
- Build 成功
- 全站雷达（Page 2）分阶段实施，V0.1 仅支持搜索/筛选入口。