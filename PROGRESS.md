# BiliScope V3.0 进度表

> 唯一进度表（Single Source of Truth）。
> 状态：✅ 完成 / 🔄 进行中 / ⏸ 阻塞 / ⬜ 未开始

---

## V3.0.0 「可验证 AI 分析系统」

> 定位：**不是重写**，在已验证的 V0.2.2 采集底座之上**重建 AI 层**。
> 目标：AI 输出必须是**可验证的数据**，禁止把 `JSON.parse(text)` 成功当作分析成功。
> 触发缺陷：AI 分析页显示 `AI 分析结果 "{\n"` —— `max_tokens=1024` 截断 + `parsed=undefined` 后 UI 回退用 `response.text` 当结果。

| 编号 | 范围 | 状态 | 备注 |
|---|---|---|---|
| **S2** | `src/ai/schemas.ts`（新）统一领域契约 | ✅ | `CommentAIResult` 10 字段（summary/facts/findings/themes/support/opposition/needs/questions/uncertainty/nextResearch）；`Finding`/`CitedClaim`/`Theme`；`DOMAIN_SCHEMAS` 一处定义、全 Provider 共用 |
| **S2-b** | 结构签名 + `superRefine` 反「幽灵成功」 | ✅ | `DOMAIN_SHAPE_KEYS` 前置校验（必须含领域骨架字段）+ `superRefine`（不得全空、必须有领域信号）→ 无关 JSON 判 `OUTPUT_SCHEMA_INVALID` |
| **S3** | `src/ai/failures.ts`（新）分层失败 | ✅ | `REQUEST_FAILED / OUTPUT_EMPTY / OUTPUT_TRUNCATED / OUTPUT_INVALID_JSON / OUTPUT_SCHEMA_INVALID / OUTPUT_REFUSAL / NO_PROVIDER / SUCCESS`；`describeFailure()` 逐码中文说明；`isTruncatedFinish` / `isRefusalFinish` |
| **S3-b** | `src/ai/types.ts` 诊断字段 | ✅ | `AnalyzeResponse` 新增 `finishReason?/finishMessage?/responseId?/modelVersion?/rawText?/parseError?/refusal?/structuredOutput?/usedMaxTokens?` |
| **S3-c** | OpenAI adapter | ✅ | 捕获 `finish_reason`/`id`/`model`/`refusal`；`rawText`/`parseError` **不回填**；降级链 `json_schema → json_object`；`resolveMaxTokens()` 三级优先级 |
| **S3-d** | Gemini adapter | ✅ | `toGeminiSchema()` 去 `additionalProperties`/`$schema`、类型大小写归一；捕获 `finishReason`/`finishMessage`/`promptFeedback.blockReason`/`responseId`/`modelVersion`；schema 不支持时降级 |
| **S3-e** | `src/ai/json-schema.ts`（新） | ✅ | `zodToJsonSchema` / `zodToStrictJsonSchema`（`required` 全填 + `additionalProperties:false`）；`unwrap()` 处理 Optional/Nullable/Default |
| **S3-f** | Provider 不错配 | ✅ | `getProviderConfig(name)` + `resolveProviderConfig(explicit?)`；修复旧 `buildAdapter({...cfg, name})` 只换名字导致「发到 A 端点却标称 B」 |
| **S4** | `max_tokens` 与截断 | ✅ | `TASK_DEFAULT_MAX_TOKENS = { comment: 4096, creator/video/idea: 2048 }`；优先级 `request → provider → 任务默认`；`OUTPUT_TRUNCATED` **默认不修复**，提示真实上限 |
| **S5** | `src/ai/orchestrator.ts`（新）统一编排 | ✅ | prepare → prompt → provider → request → parse → Zod → **一次**自动修复 → 审计落库 → 领域落库 → 强类型返回；UI 禁止消费 `unknown` |
| **S6** | 分层失败 UI 呈现 | ✅ | `AIFailureNotice` 显示真实 `code` + 中文原因 + 技术细节折叠 + 是否可重试；不再一律「AI 失败」 |
| **S7** | 自动修复上限 | ✅ | **总请求 ≤ 2**；仅无效 JSON / schema 不符可修复；修复 prompt 只允许「改写成指定 schema，不添加新的事实」；`finishReason=MAX_TOKENS` 不修复 |
| **S8** | CommentAnalysis 正式接入 | ✅ | `comments → prepareCommentAnalysis → AI → CommentAIResult Zod → mapToCommentAnalysis → commentAnalysisRepo.add()`；`AIAnalysis`=审计 / `CommentAnalysis`=产品结果 |
| **S9** | 评论 prompt 重写 | ✅ | 删除 `SCHEMA_NOTE` 冲突；`COMMENT_SCHEMA_TEXT` 与 Zod 逐字对应；`COMMENT_FORBIDDEN`（大多数用户都…/用户普遍…/观众一定…/这个视频导致…/词频≠因果） |
| **S10** | 评论 AI UI | ✅ | `CommentAIReport` 9 分区（核心结论/客观事实/主题/支持观点/质疑反对/用户需求/争议情绪/不确定性/下一步研究）；rpid 可点击定位本地评论；底部 `查看原始 AI 输出` 折叠审计 |
| **S11** | AI 历史页 | ✅ | `ai-history.html` + `pages/ai-history-page.tsx`：时间/类型/Provider·模型/状态/finishReason/解析/tokens/耗时；可展开 systemPrompt/userPrompt/rawResponse/parsedResult；`Nav` 新增入口 |
| **T** | 测试 | ✅ | `schemas`(16) / `failures`(9) / `gemini-adapter`(10) / `orchestrator`(21)；重写 `openai-adapter`(18) / `prompts`(15)；**全仓 324 passed / 1 skipped / 0 failed（32 files）** |
| **A** | 验收脚本 | ✅ | TEST 008/009 从「断言式 PASS」升级为真实 V3.0 断言：orchestrate SUCCESS + `max_tokens≥4096` + CommentAnalysis/AIAnalysis 各 1 条；截断不修复、无效 JSON 修复 1 次、无关 JSON 被拒、失败零落库 |
| **G** | 门禁 | ✅ | typecheck 0 error / lint 0 error(9 warning 均为 `scripts/` 的 `no-console`) / test 324 passed / build 4.66s / scan-secrets 无泄漏 / verify-acceptance TEST 001-009 全 PASS |

### 关键决策记录

- **唯一真相**：`CommentAIResult` 定义在 `src/ai/schemas.ts` 一处，prompt 文本、JSON Schema、Zod 校验三者同源，禁止第二套。
- **反幽灵成功**：`.default([])` + `required` 全填会让无关 JSON 变成「全空成功」，故必须加结构签名前置校验。这是本次迭代发现的**真实产品缺陷**，由 `orchestrator` 测试暴露。
- **截断不修复**：截断是「输出上限不足」而非「格式错误」，修复只会再次截断，必须如实告知用户提高上限或减少样本。
- **失败零落库**：只有 `SUCCESS` 才写 `CommentAnalysis`；失败仅留 `AIAnalysis` 审计记录。

---

## V0.2.2 裸 BV 评论采集依赖闭环修复

> 触发：真实 Chrome 在评论页直接输入本地从未采过的合法 BV（`BV1D9aA61E6v`）→ 报 `采集失败：video not found for bvid=BV1D9aA61E6v`。
> 根因：评论模块**没有**「BV → 本地 Video」bootstrap 流程，`CommentCollector` 直接 `videoRepo.findByBvid` 查不到就失败。**与评论 API / `pagination_str` / WBI 无关**。

| 编号 | 范围 | 状态 | 备注 |
|---|---|---|---|
| **P0-1** | `src/services/video-bootstrap.ts`（新） | ✅ | `ensureVideoByBvid(bvid, signal?)`：本地命中 → **0 请求**；否则 `GET /x/web-interface/view?bvid=` → 严格判码 → 建最小 Creator（统计字段 null，不伪造）→ `normalizeVideoDetail` → `videoRepo.upsertByBvid` → 返回 Dexie 中真实记录 |
| **P0-2** | `normalizeVideoDetail()`（`src/normalizers/video.ts`） | ✅ | `/view` 是嵌套 `{data:{...}}`、UP 主在 `owner.mid/name/face`；单独建 schema 但**复用** `parsePubTimeToIso`/`parseDurationToSeconds`/`parseViews`/`parseAuthor`；结构非法返回 `null` |
| **P0-3** | `CommentCollector` 依赖获取 | ✅ | 改为 `const video = await ensureVideoByBvid(bvid, signal)`；**分页逻辑零改动** |
| **P0-4** | UI 错误分类 | ✅ | `comment-page.tsx` 区分「无法获取视频信息」/「评论接口风控（环境受限）」/「采集失败」三类 |
| **A** | bootstrap happy path 测试 | ✅ | 本地无 Video → 真实 view 结构 → 自动建 Creator + Video → 评论接口 → 评论入库 Dexie |
| **B** | 已有 Video 性能测试 | ✅ | **断言 `/view` 请求数 = 0**；连续两次调用 1 → 0 |
| **C** | view 业务码非 0 测试 | ✅ | `{code:-404,data:null}` → `ok:false`/`metadataFailed`/零脏数据/**零评论请求**/错误非「video not found」 |
| **D** | view 结构非法测试 | ✅ | 缺 `data`/缺 `aid`/`bvid` 格式错 → 失败零脏数据；非法 bvid → 零请求 |
| **E** | unknown 语义测试 | ✅ | `duration`/`pubdate`/`stat` 缺失 → `null`（**不伪造 0 / `Date.now()`**）；`"03:32"` → 212s |
| **F** | 真实 BV `BV1D9aA61E6v` 回归 | ✅ | 新增真实 `/view` fixture `view-detail-BV1D9aA61E6v.json`（嵌套 `data`）；同 fixture 外层 `code=-404` 必须失败（证明判码真实生效） |
| **P0-5** | Chrome E2E spec（真实验证） | ✅ | `scripts/e2e-comment-bootstrap.mjs`：CDP 驱动真实 Chrome → 识别 BiliScope 扩展 origin（`fetch` 探测，不误认内置组件扩展）→ 清空该 BV 的 Video/Comment 并断言清理后计数为 0 → 评论页输入裸 BV → 采集 → 断言 Video 出现 + 评论入库 + `/view` 真实被访问 |

### 门禁（V0.2.2）

| 命令 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit` | ✅ EXIT=0 | — |
| `eslint` | ✅ EXIT=0 | 0 error（9 个既有 `no-console` warning，全在 `scripts/`） |
| `vitest run` | ✅ **243 passed / 1 skipped（28 files）** | 新增 `tests/services/video-bootstrap.test.ts` 19 passed |
| `vite build` | ✅ OK | 111 modules · 4.05s |
| `scan-secrets` | ✅ 0 leaks | — |
| 真实 Chrome E2E | ⚠ **`CHROME_E2E_ENV_LIMITED`** | 见下方「环境限制」 |
| `git status` → commit → push → CI | ⬜ 本轮最后执行 | **单个分组提交**（非逐模块） |

#### Chrome E2E 环境限制（如实记录，未通过 ≠ 未验证）

本机 Chrome 在命令行 `--load-extension=<dist>`（headed 与 `--headless=new` 均试）下**不加载未打包扩展**——CDP `/json/list` 只有 Chrome 自带组件扩展（Hangouts `nkeimhogjdpnpccoofpliimaahmaaome` 等），BiliScope 未出现在 targets 中。因此本机无法完成自动化 Chrome E2E，判定 **`CHROME_E2E_ENV_LIMITED`**（不是 FAIL，也不是 PASS）。

手工跑通方式：
1. `pnpm build` → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`
2. 取该扩展 ID，`EXT_ID=<id> CHROME_PATH=<chrome路径> node scripts/e2e-comment-bootstrap.mjs`

**链路已由离线全链路测试证明**（`tests/services/video-bootstrap.test.ts` F 组）：真实 `/view` fixture → 裸 BV bootstrap → 评论接口 `oid` 等于 fixture 的真实 `aid` → 评论写入 Dexie。真实网络层的最终确认待手工 Chrome 验证。

> **门禁顺序固定**：typecheck → test → lint → build → secret-scan → acceptance → git status → commit → push → CI。
> **结论分级**（最终报告不合并）：OFFLINE PASS / INTEGRATION PASS / REAL API PASS / REAL API ENVIRONMENT LIMITED / CHROME E2E PASS。

---

## V0.2.1 评论采集真实性修复（`pagination_str` 协议 + 翻页不变量 + 跨页去重）

> 触发：真实 Chrome 打开 `BV17u411E7UK` 只能取到极少量评论。根因：一级分页参数写成了**不存在**的 `pagination_reply`，正确参数是 **`pagination_str`**。

| 编号 | 范围 | 状态 | 备注 |
|---|---|---|---|
| **P0-1** | 一级分页协议 | ✅ | `buildCommentMainQuery` 统一构造 `oid/type=1/mode/pagination_str/plat=1/seek_rpid/web_location`；**删除** `pagination_reply`；`firstPagePaginationStr()` / `nextPagePaginationStr()` |
| **P0-2** | 一级测试重写 | ✅ | 删除读 `pagination_reply` 的错误假设；验证「第 1 页 next_offset=A → 第 2 请求带 pagination_str 含 A → 第 2 页不同 rpid → 唯一数正确」 |
| **P0-3** | 翻页前进不变量 | ✅ | offset 重复 → 停 + `paginationStalled`；本页唯一新增 0 → 停；连续两页 rpid 集合相同 → 停 + `duplicatePageDetected`；`is_end`/tierLimit → 正常结束；maxPages → `partial` |
| **P0-4** | 跨页去重 | ✅ | Collector 进程级 `seenRpidStr`；`fetched`（原始）与 `unique`（去重）分离 |
| **P0-5** | 二级回复分页 | ✅ | `/x/v2/reply/reply` 改 `pn` + `ps=20`，**不读** `next_offset`，末页判据 `replies.length < ps` |
| **P0-6** | 真实 fixture | ✅ | 新增 `tests/fixtures/real/comment-{main,reply}-page{1,2}.json`；全链路 `response → normalizer → collector → repository → Dexie` |
| **P0-7** | 真实 Chrome E2E | ✅ | **`REAL_API_PASS`**：`BV17u411E7UK` HTTP=200/code=0/pages=10/fetched=200/unique=200/paginationAdvanced=true/1.77s |
| **P1-8** | ID 字符串规范键 | ✅ | Repository 去重/索引/关系键优先 `rpidStr`/`midStr`/`rootRpidStr`/`parentRpidStr`/`dialogStr`；Dexie **v3 schema** |
| **P1-9** | 互动字段更新语义 | ✅ | 静态同 → `unchanged`；`like/replyCount/location/vipStatus` 变 → `updated` 且保留 `id`/`createdAt` |
| **P1-10** | 未知不伪装成 0 | ✅ | `num()` 区分真实 0 / 缺失 `null` / 失败 unknown；UI `null` → `—` |

### 门禁（V0.2.1）

| 命令 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit` | ✅ EXIT=0 | — |
| `eslint` | ✅ EXIT=0 | 0 error / 0 warning |
| `vitest run` | ✅ **224 passed / 1 skipped（27 files）** | 评论链路 36 passed；1 个 `RUN_REAL_E2E` 门控真实用例 |
| `vite build` | ✅ OK | 110 modules · 4.09s |
| `scan-secrets` | ✅ 0 leaks | — |
| `verify-acceptance` | ✅ TEST 001-009 PASSED | 010/011 延后至 commit/push 后 |
| `RUN_REAL_E2E=1` | ✅ **`REAL_API_PASS`** | `pages=10 fetched=200 unique=200 paginationAdvanced=true` |
| `git status` → commit → push → CI | ⬜ 本轮最后执行 | **单个分组提交**（非逐模块） |

> **门禁顺序固定**：typecheck → test → lint → build → secret-scan → acceptance → git status → commit → push → CI。
> **结论分级**（最终报告不合并）：OFFLINE PASS / INTEGRATION PASS / REAL API PASS / REAL API ENVIRONMENT LIMITED / CHROME E2E PASS。

---

## V0.2.0 大版本升级（评论深度 / 研究能力 / 任务系统 / 灵感闭环）

> 目标：从「能采集」走向「能研究」。批处理 + 并行任务组（A–G）+ 分阶段统一验收；
> 不删 DB、不重装依赖、不删 pnpm-lock、不重 init git、不做无关架构重构、不削弱断言、不伪造真实 B 站成功。

| Group | 范围 | 状态 | 备注 |
|---|---|---|---|
| **A** | 评论游标分页 + 楼中楼 + 字段升级 + 环境受限区分 | ✅ | Dexie v2 schema（移除陈旧 `memberId` 索引）；`/x/v2/reply/wbi/main` 游标翻页（`pagination_reply.next_offset`/`is_end`/`all_count`）；`mode=2` 时间 / `mode=3` 热度；`/x/v2/reply/reply` 楼中楼；**删除硬编码 `pn<=3`**；`CollectorErr.diagnostics`；0 条且环境受限 → `ok:false` |
| **B** | 视频时序快照 + 检查点调度 | ✅ | `analytics.ts` 纯函数：6 检查点（首次/6h/24h/48h/7d/30d）+ Voronoi 最近邻归点；`dueSnapshotCheckpoints()` 决定是否写快照；单视频快照失败不中断批次 |
| **C** | 账号研究 + 雷达生态 | ✅ | `creator-research.ts`：内容结构 / 内容变化 / 突破视频检测 / 雷达关键词描述；creator-page + radar-page 接入 |
| **D** | 灵感闭环（热点→灵感→实验） | ✅ | `idea-loop.ts`：`sourceRef` / `ideaId` 来源回溯；9 状态显式白名单状态机；`IdeaStatus` 增 `reviewing`/`archived` |
| **E** | 研究 UI（评论 / 账号 / 雷达 / 我的数据 / 热点） | ✅ | 评论页 P0-E 统计表 + 排序/分级/深度 + 诊断行 + AI「推测」分区标注；热点页「转为灵感」+ 风险提示；我的数据接入 `runTask`；`warn`/`error`/`ok` CSS |
| **F** | 评论 AI 分析（事实 / 推断分离） | ✅ | `comment-prep.ts`：清洗→去重→统计→构造上下文；prompt 携带独立 `facts` + `sample`（带 rpid）；system 强制 rpid 引用 + 不得编造数字 |
| **G** | 任务 / 进度系统 | ✅ | `task-runner.ts`：`runTask` 统一包装；`classifyFailure` 区分环境受限；UI「任务」页（3s 自动刷新、进行中/环境受限/总数计数）；nav + vite 注册 |

### 门禁（V0.2.0）

| 命令 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit` | ✅ EXIT=0 | — |
| `eslint` | ✅ EXIT=0 | 0 error / 0 warning |
| `vitest run` | ✅ **201 passed / 1 skipped（27 files）** | 1 个 `RUN_REAL_E2E` 门控真实用例 |
| `vite build` | ✅ OK | 见下方最终门禁 |
| `scan-secrets` | ✅ 0 leaks | — |
| `verify-acceptance` | ✅ TEST 001-009 PASSED | — |
| `git status` → commit → push → CI | ⬜ 本轮最后执行 | **单个分组提交**（非逐模块） |

> **门禁顺序固定**：typecheck → test → lint → build → secret-scan → acceptance → git status → commit → push → CI。
> **结论分级**（最终报告不合并）：OFFLINE PASS / INTEGRATION PASS / REAL API PASS / REAL API ENVIRONMENT LIMITED / CHROME E2E PASS。

---

## V0.1.4 修复（数据迁移 · videoRepo.upsertByBvid 业务字段比较）

> 触发：独立审计员在 Chrome 实机（UID 946974 · 影视飓风）加载 V0.1.3 dist 后，**视频仍全部 0s / 当天日期**。
> 排查结论：「代码修复成功，数据迁移失败」——V0.1.3 只修了 `normalizer`，但 `videoRepo.upsertByBvid()` 仍只比较 `title + tags.length` 即返回 `unchanged`，
> 于是 V0.1.0/V0.1.2 写入的脏 `Video`（`pubTime=今天`、`duration=0`、`views=null`）在重新采集时永远不被更新。

| # | 级别 | 阶段 | 状态 | 备注（真实证据） |
|---|---|---|---|---|
| 1 | P0 | `videoRepo.upsertByBvid` 业务字段比较 | ✅ | 新增 `videoBusinessChanged(a,b)` 比较 aid/creatorId/title/description/cover/pubTime/duration/category/url/authorName/authorMid/views/tags；旧实现只看 `title+tags.length` → 历史脏数据无法自愈 |
| 2 | P0 | 更新保留首次采集时间 | ✅ | 更新时展开 `video` 后显式保留 `existing.createdAt`、`updatedAt:nowIso()`、沿用旧 `id`；不再把新采集时间写回 `createdAt` |
| 3 | P0 | 回归测试 | ✅ | `tests/repositories/index.test.ts` 新增 2 条：同 title+tags 但 pubTime/duration/views 变 → `updated=1` + 回读纠正 + `createdAt` 保留；字段全同 → `unchanged=1` |
| — | — | 门禁全绿 | ✅ | 153/153 单测（含 2 新用例）· typecheck 0 · lint 0 · build OK · 0 secrets · TEST 001-009 PASSED |
| — | — | 用户实机复验 | ⏳ | 用户需在 Chrome 对影视飓风**重新采集一次**，确认脏数据被 `upsert` 自愈；**不靠清空数据库规避** |

---

## V0.1.3 修复（Chrome 实机验收 · 归一化字段映射 + 三层降级 + 原子导入）

> 触发：独立审计员**实际在 Chrome 里加载 V0.1.2 dist** 采集 UID 946974（影视飓风），
> 发现"采到了数据但归一化字段映射错了"——粉丝/关注/投稿全 0、趋势快照全 0、
> 视频发布时间全显示今天、时长全 0s。本轮回溯源码前**先读真实 API 响应**（`scripts/probe-real-api.ts` 落盘 14 份真实响应到 `tests/fixtures/real/`），再决定映射。

| # | 级别 | 阶段 | 状态 | 备注（真实证据） |
|---|---|---|---|---|
| 1 | P0 | Creator 字段映射 | ✅ | 真实 `/x/space/wbi/acc/info` 用 `fans/attention/archive_count`；`/x/web-interface/card` 的 `mid` 为**字符串**、`following` 为**布尔**；三级来源 `/x/relation/stat`(follower/following) + `/x/space/navnum`(video) 补充；彻底删除 `?? 0`，未知一律 `null`，UI 显示 `–` |
| 2 | P0 | `CreatorSnapshot` 计数器可空 | ✅ | `followers/following/videoCount` schema 改 `number \| null`；`level` 可空 |
| 3 | P0 | `VideoNormalizer` 真实字段 | ✅ | 投稿列表 `data.list.vlist[]` 真实字段为 `created`(时间戳)/`length`("12:34")/`play`/`author`/`mid`；`duration` 解析不出→`null`（不再回退 0），`pubTime` 用 `created`/`pubdate`，**绝不回退 `Date.now()`** |
| 4 | P0 | 真实 fixture 测试 | ✅ | `tests/fixtures/real/arc-search-wbi.json`（真实 `created/length/play/author/mid`）；验证 created→pubTime（断言≠今天）、length→duration、play→views、author→authorName、mid→authorMid、缺失→null |
| 5 | P0 | `VideoCollector` 不再逐条 `/view` | ✅ | 默认 `fetchDetails=false`；列表自带 `play`→初始 `VideoSnapshot`（其余 null）；日志 `list requests=N, detail view requests=M`，M≠视频数（实测 M=0） |
| 6 | P0 | Video / VideoSnapshot 拆分稳定/时变字段 | ✅ | `Video`：bvid/aid/title/author/pubTime/duration/category/tags/creatorId；`VideoSnapshot`：views/likes/coins/favorites/shares/comments/danmaku 均 `number \| null` |
| 7 | P1 | SearchCollector 真实链路 | ✅ | 真实 `search/type` 的 `data.result` 是**数组**非 `{video:[]}`；端点 `/x/web-interface/wbi/search/type`→降级 `/search/type`→未签名；保留 bvid/aid/mid/author/title/description/play/duration/pubdate/tag；Radar 显示真实 UP 名 + 播放 |
| 8 | P1 | HTTP 5xx 重试修复 | ✅ | 旧实现 catch 中无条件 `status:undefined` 抹掉 5xx→永不重试；现仅在无 status 时置 undefined，`retryable` 正确；`503→503→200` 成功、`503×4` 失败 |
| 9 | P1 | Import 替换原子性 | ✅ | 先全量 Zod 校验，任一非法则**整体拒绝**（旧数据不动）；全部合法才单事务 `clear+bulkPut`；新增 `replace 整体拒绝` 单测 |
| 10 | P1 | 版本号统一 | ✅ | package.json / manifest.json / DEPLOYMENT / CHANGELOG / FINAL_AUDIT / PROGRESS 全部对齐 **V0.1.3** |
| 11 | P1 | Smoke 语义 | ✅ | `PASS`/`PASS_WITH_ENV_LIMIT`/`FAIL` 三态；风控失败绝不叫 PASS；新增 `tests/smoke/classify.ts` + 真实 E2E 链路测试 |
| 12 | — | 真实 E2E 链路 | ✅ | `CreatorCollector→Repository→Dexie`、`SearchCollector→Dexie`、`VideoCollector`（detail=0）均实测通过，断言真的落库 |
| — | — | 门禁全绿 | ✅ | 151/151 单测 · typecheck 0 · lint 0 · build OK · 0 secrets · TEST 001-009 PASSED |

---

## V0.1.2 修复（独立验收第二轮 · P0 x4 + P1 x6）

| # | 级别 | 阶段 | 状态 | 备注 |
|---|---|---|---|---|
| 1 | P0 | 真正实现 MD5 WBI 签名 | ✅ | 新增 `src/utils/md5.ts`（RFC 1321 纯 JS）；`w_rid = MD5(query + mixin_key)`；**顺带修掉 mixin key 只取到 sub_key 的隐藏 bug**；新增 `buildWbiQuery()` 保证签名与请求 URL 编码同源；MD5 由 RFC 向量 + Node crypto 差分双重校验 |
| 2 | P0 | WBI 接口失败时真正 fallback | ✅ | 风控是 HTTP 200 + `code=-352/403/412` 不抛异常。新增 `src/utils/bili.ts`（`biliCode/isBiliBlocked/hasBiliData`）；Creator 与 Video 两条链路改成「业务码不可用 → 降级 legacy」，不再只在签名抛错时降级 |
| 3 | P0 | SearchCollector 真实 Chrome 请求链路 | ✅ | 请求带 bilibili 域 `referrer`（http 层新增 `referrer` 透传）；URL 走真实 WBI 签名，签名失败回退未签名，被拦再回退一次 |
| 4 | P0 | Radar 的 UP / views 不丢 | ✅ | `Video` 新增可选 `authorName/authorMid/views`；`creatorId` 由字面量 `search` 改为 `uid:{mid}`；Radar 新增「播放」列，UP 列显示真实 UP 名，时长改用 `formatDuration` |
| 5 | P1 | Import 写入前真正 Zod validate | ✅ | `IMPORT_TABLE_SCHEMAS` 12 张表逐条 `safeParse`；非法行跳过 + 计数；preview 上报 `counts/invalid/errors`，apply 返回 `imported/skipped` |
| 6 | P1 | unknown ≠ 0 | ✅ | `CreatorSnapshot.totalViews/totalLikes/...` 改 `number \| null`；`normalizeCreatorTotals` 返回 `null + available=false`；UI `formatInt` 显示 `–` |
| 7 | P1 | Comment 新增数用真实计数 | ✅ | `CollectorOk.stats{added,updated,unchanged}`；Comment 页显示「新增 / 已存在 / 抓到」三项，不再用 `data.length` |
| 8 | P1 | 缓存命中不制造 snapshot | ✅ | 新增 `cachedWithMeta()`；命中时 `fetched=false` 且不写时序快照 |
| 9 | P1 | HotTopic 按业务键去重 | ✅ | `hotTopicBusinessId(source,title)` = md5 前 16 位；bulkPut 变 upsert；repo 返回真实 `added/updated` |
| 10 | P1 | Smoke test 从普通 CI 分离 | ✅ | `vitest.config.ts` 排除 `tests/smoke/**`；新增 `vitest.smoke.config.ts` + `pnpm test:smoke`；CI 默认离线 + `scripts/assert-smoke-isolated.mjs` 守卫；smoke 改 `workflow_dispatch` 手动触发 |
| — | — | 门禁全绿 | ✅ | 136/136 tests · typecheck 0 · lint 0 · build OK · 0 secrets · TEST 001-009 PASSED |
| — | — | commit + push + CI | ✅ | commit `737d347`（40 files, +1612/-250）→ Run #36419334471 ✓ 47s，8/8 steps success，smoke job skipped |

---

## V0.1.1 修复（独立验收反馈 · 真实数据链路问题）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 1) CreatorCollector: acc/info 加 mid + 切到 wbi/acc/info | ✅ | V0.1.1 修复：URL `wbi/acc/info?mid={uid}` + WBI 签名，失败降级 legacy |
| 2) CreatorCollector: upstat 加 mid + 容错（非致命） | ✅ | upstat 失败 → creator 仍采集成功，totals=0 |
| 3) VideoCollector: 接入 signWbi() | ✅ | V0.1.1：先 refreshWbi() 拉 nav，再用 signWbi() 签 URL |
| 4) Video normalizer: duration 兼容 string | ✅ | 新增 parseDurationToSeconds：number / numeric string / "MM:SS" / "HH:MM:SS" |
| 5) SearchCollector: 真实搜索响应结构 | ✅ | 新增 normalizeSearchVideo / normalizeSearchVideoList，剥离 `<em>` 高亮 |
| 6) buildCreatorAnalyzePrompt: 修 views: v.duration 字段错 | ✅ | 改为 duration: v.duration（views 数据由 snapshots 段提供） |
| 7) CreatorCollector: 返回持久化 ID 而非 temp ID | ✅ | upsert 后用 persistedId 重读并返回 |
| 8) 真实 API smoke test | ✅ | tests/smoke/real-api.test.ts · 3 cases · 命中 B 站真实 nav / search / view |
| 9) typecheck + lint + test + build 全绿 | ✅ | 113/113 tests · 0 lint · build OK · 0 secrets |
| 10) commit + push + CI 绿色 | ✅ | commit `5223dcd` + Run #36413095312 (✓ 35s) |

---

## 总体进度（V0.1 已交付 · 全 ✅）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 侦察 + 开源审计 | ✅ | 6 个仓库 License 全部确认 |
| 仓库初始化 + 根目录文档 | ✅ | git init + 9 份根目录文档 + DEPLOYMENT.md |
| 脚手架与工具链 | ✅ | Vite + React 18 + TS5 + crxjs + Vitest + ESLint + Prettier + tsx |
| 工具层（utils） | ✅ | 6 个模块 |
| 数据层（models + zod + Dexie） | ✅ | 12 张表 + Repository CRUD |
| 归一化层（normalizers） | ✅ | 4 个 normalizer |
| 采集层（collectors） | ✅ | 5 个 Collector |
| AI 层（4 adapter + service + prompts） | ✅ | OpenAI-compatible / DeepSeek / Gemini / Custom |
| UI 主体 | ✅ | popup + options + 6 page + content + background |
| 服务层（export / import） | ✅ | JSON 全量 + CSV |
| CI workflow | ✅ | GitHub Actions 7 步 |
| Open-source 审计文件 | ✅ | OPEN_SOURCE_AUDIT.md 完整 |
| 测试 | ✅ | 73/73 单测 + 集成 |
| Lint | ✅ | 0 errors / 0 warnings |
| Build | ✅ | vite build 成功，59 文件产物 |
| Secret scan | ✅ | 0 leaks |
| 自动验收（TEST 001-011） | ✅ | **11/11 PASS** |
| GitHub 仓库创建 + push | ✅ | **https://github.com/SHUMLU0/BiliScope** |
| FINAL_AUDIT.md | ✅ | 已生成并更新 |

---

## 最终门禁（V0.1）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ 73/73 PASS，16/16 files，EXIT=0 |
| `pnpm build` | ✅ EXIT=0，59 files in dist/ |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED |
| `git push → CI` | ✅ Run #36411153975，✓ verify，1m4s |
| `git status` | ✅ clean（commit 9a1f248） |

---

## V0.1.1 门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ **113/113 PASS**（19 files，新增 6 V0.1.1 单测 + 3 smoke） |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED |
| `git push → CI` | ✅ Run #36413095312（✓ 35s） |

---

## V0.1.2 门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ **136/136 PASS**（21 files，离线、不含 smoke） |
| `pnpm test:smoke` | ✅ 4/4 PASS（真实网络，手动执行） |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `node scripts/assert-smoke-isolated.mjs` | ✅ OK |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED |
| `git push → CI` | ✅ Run #36419334471（✓ 47s，8/8 steps success，smoke job skipped），commit `737d347` |

---

## V0.1.3 门禁（本轮 · Chrome 实机验收后最小修复）

| 命令 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit` | ✅ EXIT=0 | `tc.log` EXIT=0 |
| `eslint` | ✅ EXIT=0 | 0 error / 0 warning |
| `vitest run` | ✅ **151/151 PASS**（21 files） | `test.log` Tests 151 passed |
| `vite build` | ✅ EXIT=0 | 101 modules，built in 4.63s |
| `scan-secrets` | ✅ 0 leaks | `[OK] no secrets detected` |
| `verify-acceptance` | ✅ TEST 001-009 PASSED | `acc.log` All TEST 001-009 PASSED |
| smoke 真实 E2E | ✅ 8/8（含真实 UID 946974） | `[smoke:PASS] uid=946974 name=影视飓风 followers=18443072 following=686 videoCount=946 level=6`；`[smoke:PASS_WITH_ENV_LIMIT] wbi/acc/info code=-352，legacy code=-799`；`[smoke:PASS_WITH_ENV_LIMIT] video collect: HTTP 412` |
| Chrome 实机验收（UID 946974） | ⏳ 待手动加载 dist/ 验证 | 见 FINAL_AUDIT § 实机验收清单 |
| `git status` → commit → push → CI | ⬜ 未开始 | 本轮最后执行 |

> **门禁顺序固定**：typecheck → test → lint → build → secret-scan → acceptance → git status → commit → push → CI。
> **结论分级**（最终报告不合并）：离线单测通过 / 真实 API 可验证 / 真实 API 受风控无法验证 / Chrome 实机通过。

---

## 下一阶段（不在 V0.1 / V0.1.1 / V0.1.2 / V0.1.3 范围）

- V0.2：50w+ Creator Index + 实验闭环 + 榜单时序（快照语义）索引
- WBI 端到端成功仍需有 Cookie / 低风控出口的环境复验（见 `FINAL_AUDIT.md` § 10 已知限制）
- 详见 `FINAL_AUDIT.md` § 8 § 9