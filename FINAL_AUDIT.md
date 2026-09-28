# FINAL_AUDIT.md — BiliScope V0.2.2 最终审计

> 生成于 2026-09-28 · 当前版本 **V0.2.2**（裸 BV 评论采集依赖闭环修复：`ensureVideoByBvid` bootstrap）· **本地全门禁通过** · GitHub: https://github.com/SHUMLU0/BiliScope
>
> 承接：V0.1.1 数据链路修复 → V0.1.2 真实链路最小修复 → V0.1.3 归一化字段映射修复 → V0.1.4 数据迁移修复 → V0.2.0 研究能力升级 → V0.2.1 评论采集真实性修复 → **V0.2.2 裸 BV 评论采集依赖闭环修复**

---

## 0-septies. V0.2.2 裸 BV 评论采集依赖闭环修复（P0 依赖前置）

> 触发：真实 Chrome 在评论页直接输入一个**本地从未采过**的合法 BV（`BV1D9aA61E6v`）→ 报 `采集失败：video not found for bvid=BV1D9aA61E6v`。
> 目标：让「裸 BV」自己补齐依赖（BV → Video → aid → 评论），**绝不用 mock 冒充真实成功**。

### 根因（一句话）

评论模块**没有**「BV → 本地 Video 记录」的 bootstrap 流程。调用链是 `comment-page.tsx → handleFetch() → CommentCollector.collectComments(bvid) → videoRepo.findByBvid(bvid)`，本地查不到就直接返回 `video not found for bvid=<BV>`。**这与评论 API / `pagination_str` / WBI 完全无关**——V0.2.1 已修好评论协议，这里缺的是**依赖前置条件**。`src/content/detect.ts` 的 `bvidToAid()` 只取 aid、不写 Video，不是完整修复。

### 修复清单

| 编号 | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| P0-1 | P0 | 评论模块无「BV → Video」bootstrap | 新增 `src/services/video-bootstrap.ts`：`ensureVideoByBvid(bvid, signal?)` —— 本地命中直接返回（`fetched:false`）；否则 `GET /x/web-interface/view?bvid=`（Referer `.../video/<BV>`，匿名）→ 严格判码 → 建**最小** Creator（统计字段 `null`）→ normalize → `videoRepo.upsertByBvid()` → 返回 Dexie 中真实记录 | 测试 A/B/F：happy path、`/view` 请求数 0/1、fixture 全链路 |
| P0-2 | P0 | `/view` 是嵌套结构，硬塞列表 schema 会把缺失字段默认成空串 | 新增 `normalizeVideoDetail()`（单独 schema，但**复用** `parsePubTimeToIso`/`parseDurationToSeconds`/`parseViews`/`parseAuthor`）；`owner.mid/name/face` → 最小 Creator；结构非法 → `null`，不写脏数据 | 测试 D/E：缺 `data`/缺 `aid`/格式错 → 零脏数据 |
| P0-3 | P0 | Collector 直接 `findByBvid` | 改为 `const video = await ensureVideoByBvid(bvid, signal)`；**分页逻辑零改动** | 评论测试 28 passed（分页/去重/不变量全部保留） |
| P0-4 | P1 | UI 把一切失败压成「采集失败」 | `comment-page.tsx` 区分「无法获取视频信息」/「评论接口风控（环境受限）」/「采集失败」 | 测试 C 断言错误文案非本地「video not found」 |
| P0-5 | P0 | 无真实 E2E 证明链路 | 新增 Chrome E2E spec `scripts/e2e-comment-bootstrap.mjs` | 见下表 |

### 真实链路验收（与工程门禁分开记录）

| 项 | 结果 |
|---|---|
| 真实 Chrome E2E（`scripts/e2e-comment-bootstrap.mjs`） | ⚠ **`CHROME_E2E_ENV_LIMITED`** —— 本机 Chrome 在命令行 `--load-extension` 下不加载未打包扩展（headed 与 `--headless=new` 均试；CDP targets 中只有 Chrome 内置组件扩展）。**非 FAIL**：链路已由离线全链路测试证明。手工跑法见 DEPLOYMENT.md 第八节。 |
| 真实 `/view` 是否被访问 | 离线层：✅ 由 fixture + Collector 断言「先 view(1 次) → 评论接口 `oid=<真实 aid>`」；真实网络层：待手工 Chrome 确认 |
| 离线全链路（fixture） | ✅ 通过：裸 BV → bootstrap → 评论接口带 fixture 真实 aid `113600005346789` → 评论写入 Dexie |

> **结论口径不合并**：`typecheck/test/lint/build` 全绿 = **工程门禁 PASS**；真实 Chrome E2E = `CHROME_E2E_ENV_LIMITED`（本机环境限制，**不冒充 PASS，也非 FAIL**）。**绝不用 offline fixture PASS 冒充 real API PASS**。

### 工程门禁（与真实链路**不合并**）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ EXIT=0 |
| `eslint` | ✅ EXIT=0（0 error / 9 warning，均为 `scripts/` 既有 `no-console`） |
| `vitest run` | ✅ **243 passed / 1 skipped（28 files）** |
| `vite build` | ✅ OK（111 modules · 4.05s） |
| `scan-secrets` | ✅ 0 leaks |

---

## 0-sexies. V0.2.1 评论采集真实性修复（P0 数据链路）

> 触发：真实 Chrome 打开 `BV17u411E7UK` 只能取到**极少量评论**；一级/二级分页协议与真实接口不符。
> 目标：对齐真实协议 → 补翻页不变量 → 跨页去重 → 真实接口验证。**绝不用 mock 冒充真实成功**。

### 根因（一句话）

一级分页参数写成了 **`pagination_reply`**（该参数在真实协议中不存在），正确参数是 **`pagination_str`**（值为 `{"offset":"<上一页 next_offset>"}`，其中 `next_offset` 本身是 JSON 字符串）。参数名错 → 服务端只回第一页 → 表现为「只能拿到极少量评论」。

### 修复清单

| 编号 | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| P0-1 | P0 | 一级分页 URL 参数用错（`pagination_reply`） | 新增 `buildCommentMainQuery({aid,mode,paginationOffset})` 统一构造 `oid/type=1/mode/pagination_str/plat=1/seek_rpid=''/web_location=1315875`；新增 `firstPagePaginationStr()` / `nextPagePaginationStr()`；**删除** `pagination_reply` 参数 | `P0-1 协议构造` 5 测试（含 `expect(sp.has('pagination_reply')).toBe(false)`） |
| P0-2 | P0 | 一级测试断言错误（读 `pagination_reply`） | 重写：验证第 1 页 `next_offset=A` → 第 2 次请求带 `pagination_str` 且含 A → 第 2 页 rpid 不同 → 唯一数正确 | 测试断言 URL 序列 + offset 传递，而非只看 `data.length` |
| P0-3 | P0 | 无翻页不变量（会反复烧请求 / 重复填档） | 维护 `previousOffset`/`currentOffset`/`seenRpidStr`：① offset 重复 → 停 + `paginationStalled`；② 本页唯一新增 0 → 停；③ 连续两页 rpid 集合相同 → 停 + `duplicatePageDetected`；④ `is_end` → 正常结束；⑤ tierLimit → 正常结束；⑥ maxPages → `partial` | stalled / duplicate-page / maxPages 用例；日志如 `pages=2 fetched=6 unique=3 duplicatePage=true` |
| P0-4 | P0 | 无跨页去重，`fetched` 与 `unique` 混同 | Collector 进程级 `seenRpidStr` 跳过已见 `rpidStr`；`fetched`（原始）/`unique`（去重）分离 | P0-4 用例：`fetched=20 unique=15`（第 2 页部分重叠） |
| P0-5 | P0 | 二级回复错用一级游标逻辑 | `collectSubReplies` 改 `pn` 递增 + `ps=20`；**不读** `pagination_reply.next_offset`；末页判据 `replies.length < ps` | pn=[1,2,3] / sub=47(20+20+7) → 二级 23 条；重复 rpid 去重用例 |
| P0-6 | P0 | 无真实响应 fixture | 新增 4 个真实结构 fixture（main page1/page2、reply page1/page2），覆盖 `rpid/rpid_str/mid/mid_str/parent/root/dialog/rcount/like/ctime/member/content/cursor/pagination_reply.next_offset` | fixture 全链路用例：`response → normalizer → collector → repository → Dexie` |
| P0-7 | P0 | 无真实链路证据 | E2E：先取真实 `aid`，再 `standard=200/depth=top/sort=time` | **`REAL_API_PASS`**（见下表） |
| P1-8 | P1 | JS Number 精度可能误合并评论 | 保留 `rpid`/`mid` 兼容字段，Repository 去重/索引/关系键优先 `rpidStr`/`midStr`/`rootRpidStr`/`parentRpidStr`/`dialogStr`；Dexie **v3 schema** 新增索引 | 大 `rpidStr` 用例：`Number(big1)===Number(big2)` 但必须落 2 行 |
| P1-9 | P1 | 互动字段变化被忽略 / `createdAt` 被覆盖 | 静态字段同 → `unchanged`；`like/replyCount/location/vipStatus` 变 → `updated` 且保留 `id`/`createdAt` | 3 条 P1-9 用例 |
| P1-10 | P1 | 缺失字段伪装成 0 | `num()` 区分真实 0 / 缺失 `null` / 失败 unknown；UI `null` → `—` | 缺失 `location` → `undefined` 用例 |

### 真实链路验收（P0-7 · 与工程门禁分开记录）

```
[REAL E2E] {"ok":true,
  "stats":{"added":200,"updated":0,"unchanged":0,"pages":10,
           "expectedTotal":11695,"fetched":200,"unique":200},
  "diagnostics":{"pages":10,"fetched":200,"stored":200,"biliCode":0,
                 "paginationAdvanced":true}}
```

| 指标 | 实测值 |
|---|---|
| 视频 / aid | `BV17u411E7UK` / `532669355`（真实 view API 取回） |
| HTTP / 业务码 | `200` / `code=0`（无风控） |
| 页数 | **10** |
| 声明总数 `expectedTotal` | 11695 |
| 原始抓取 `fetched` | 200 |
| **唯一入库 `unique`** | **200**（`fetched === unique`，零重复） |
| `paginationAdvanced` | **true** |
| `environmentLimited` | false |
| 耗时 | 1.77s（串行翻页） |
| **判定** | **`REAL_API_PASS`** |

> 修复前只能取到个位数评论；修复后连翻 10 页取满 200 条且每条唯一 —— 证明 `pagination_str` 协议与翻页不变量均正确生效。

### 工程门禁（与真实链路**不合并**）

| 项 | 结果 |
|---|---|
| typecheck | ✅ 0 errors |
| lint | ✅ 0 problems |
| test | ✅ **224 passed / 1 skipped（27 files）**（评论链路 36 passed） |
| build | ✅ OK（110 modules · 4.09s） |
| scan-secrets | ✅ no secrets detected |
| verify-acceptance | ✅ TEST 001-009 PASSED（010/011 延后至 commit/push 后） |

### 结论分级（本节不合并）

| 层级 | 结果 | 说明 |
|---|---|---|
| **OFFLINE PASS** | ✅ | typecheck / lint / 单测（224 passed）/ build / scan-secrets / verify-acceptance 全绿 |
| **INTEGRATION PASS** | ✅ | Collector→Repository→Dexie 链路实测落库（TEST 003/004/005/006）+ 4 个真实 fixture 全链路用例 |
| **REAL API PASS** | ✅ **本次达成** | `BV17u411E7UK`：pages=10 / fetched=200 / unique=200 / paginationAdvanced=true |
| **REAL API ENV LIMIT** | ✅ 已正确区分 | 风控（-352/-412/-509）→ `ok:false` + `environmentLimited`，绝不谎称成功 |
| **CHROME E2E PASS** | ⏳ 待手动加载 `dist/` | 见实机验收清单 |

### 用户关键约束遵守情况

- ✅ **没有**「任务→报告→任务→报告」：读 → TODO → 协议核对 → P0 批量修 → 批量测 → 一次性回归 → 真实 smoke → 终检。
- ✅ **没有**重装依赖；**没有**删 `pnpm-lock.yaml`；**没有**重新 init git。
- ✅ **没有**无关架构重构 / UI 重构；**没有**削弱断言以通过测试。
- ✅ **没有** mock 冒充真实 B 站成功，**没有**伪造「采集完成」。
- ✅ 顺带修复测试基建缺陷（`globalThis.fetch` 不被 `vi.restoreAllMocks()` 还原导致 E2E 被污染）。

---

## 0-quinquies. V0.2.0 大版本升级（分组 A–G · 批处理执行）

> 目标：从「能采集」走向「能研究」。**批处理 + 并行任务组（A–G）+ 分阶段统一验收**，不做「任务→报告→任务→报告」。
> 硬约束：不删 DB、不重装依赖、不删 `pnpm-lock.yaml`、不重 init git、不做无关架构重构、**不削弱断言以通过测试**、**绝不伪造真实 B 站成功**。

### 分组完成情况

| Group | 范围 | 状态 | 关键实现 |
|---|---|---|---|
| **A** | 评论游标分页 + 楼中楼 + 字段升级 + 环境受限区分 | ✅ | Dexie **v2 schema** 修复陈旧索引（移除 `memberId`）；`/x/v2/reply/wbi/main` 真游标（`pagination_reply.next_offset` 可 `null`、`is_end`、`all_count`）；`mode=2` 时间 / `mode=3` 热度；`/x/v2/reply/reply` 楼中楼（`rootRpid`/`parentRpid`/`replyLevel`）；**删除硬编码 `pn<=3`**；`CollectorErr` 加 `diagnostics`；**0 条且环境受限 → `ok:false`（不再显示「采集完成 0 条」）** |
| **B** | 视频时序快照 + 检查点调度 | ✅ | 新增 `src/services/analytics.ts`（纯函数，无 Dexie/无网络）：`VIDEO_SNAPSHOT_CHECKPOINTS`（首次/6h/24h/48h/7d/30d）、`selectSnapshotPoints`（Voronoi 最近邻归点）、`computeSnapshotGrowth`、`computeCommentStats`、`countKeywords`、`topComments`；`video-collector` 新增 `dueSnapshotCheckpoints(firstTs, existingTs, nowIso)`，仅当有到期检查点才写快照；单视频快照失败不中断批次 |
| **C** | 账号研究 + 雷达生态 | ✅ | 新增 `src/services/creator-research.ts`：`creatorContentStructure`（分区/时长分布、Top 标签、发布时段）、`creatorContentChange`（前/后半段对比：分区迁移、平均时长差、30 天发布速率）、`detectBreakoutVideos`（≥ 中位数 2×，最少 5 样本）、`radarKeywordSummary`（仅描述性）、`creatorTimelineSummary`、`creatorFacts` |
| **D** | 灵感闭环（热点→灵感→实验） | ✅ | 新增 `src/services/idea-loop.ts`：`IDEA_TRANSITIONS` 显式白名单状态机（9 状态）、`canTransition`、`hotTopicToIdea`（记录 `sourceRef`）、`ideaToExperiment`（关联 `ideaId`）、`transitionIdea`（非法跳转抛错）；`IdeaStatus` 增 `reviewing`/`archived`；`experimentSchema` 增 `ideaId` |
| **E** | 研究 UI（评论 / 账号 / 雷达 / 我的数据 / 热点 / 任务） | ✅ | 评论页 P0-E 统计表（总量/已采/顶层/楼中楼/平均点赞/最高点赞/回复率/时间跨度）+ 排序（点赞/时间/回复）+ 关键词过滤 + Top5 评论 + 关键词 + 诊断行；**AI 段标注「推测，须与统计事实对照」**；账号页新增「内容结构/内容变化/突破视频/账号变化」；雷达页新增关键词描述段；热点页新增「转为灵感」+ 风险提示；我的数据接入 `runTask`；`global.css` 补 `warn`/`error`/`ok` |
| **F** | 评论 AI 分析（事实 / 推断分离） | ✅ | 新增 `src/services/comment-prep.ts`：`prepareCommentAnalysis`（清洗→去重[`rpidStr` AND `uname#content`]→统计[基于原始评论]→关键词/Top→按点赞/时间采样并标注 truncated）；`serializeCommentFacts`（仅事实 JSON）；`buildCommentAnalyzePrompt` 携带**独立的 `facts` 段 + 带 `rpid` 的 `sample` 段**；system 强制「引用 rpid + facts 段不得编造数字」 |
| **G** | 任务 / 进度系统 | ✅ | 新增 `src/services/task-runner.ts`：`createTask`/`markRunning`/`updateProgress`/`cancelTask`；`runTask` 统一包装（成功→`success`，环境受限但有数据→`partial`，失败→`failed`，抛错→捕获为 `failed`）；`classifyFailure` 通过 diagnostics 或正则（`-412|-509|-352|-403|风控|未登录|环境受限`）判定环境受限；UI 新增「任务」页（3s 自动刷新、进行中/环境受限/总记录计数、诊断展示）；`Nav` + `vite.config.ts` 注册 `pages/tasks` |

### 工程与门禁

| 编号 | 级别 | 事项 | 结果 | 验证 |
|---|---|---|---|---|
| #1 | P0 | Dexie v2 schema（评论索引修复） | ✅ | `this.version(2).stores({ comments: 'id, videoId, rpidStr, rootRpid, replyLevel, ctime, [videoId+ctime], [videoId+replyLevel]' })`；v1 保留（12 张表） |
| #2 | P0 | 归一化器真实响应解析 | ✅ | `normalizeCommentPage` 直接解析完整 `{code,data,message}`（不再包一层 `data`）；失败保留真实 `code`/`message`；`next_offset` 允许 `null` |
| #3 | P0 | `CollectorErr.diagnostics` | ✅ | 环境受限失败携带 httpStatus/biliCode/pages/fetched/stored/environmentLimited |
| #4 | P1 | 纯函数分析层 | ✅ | `analytics.ts` / `creator-research.ts` / `idea-loop.ts` / `comment-prep.ts` 均无 IO，便于单测 |
| #5 | P1 | 任务类型扩展 | ✅ | `collectionTaskTypeEnum` 新增 `my-data`（我的数据整链路登记为一个任务） |
| #6 | P1 | 版本号统一 | ✅ | package.json / manifest.json / CHANGELOG / DEPLOYMENT / FINAL_AUDIT / PROGRESS 全部对齐 **V0.2.0** |
| — | — | 门禁全绿 | ✅ | typecheck 0 · lint 0 · **`vitest run` 201 passed / 1 skipped（27 files）** · build OK（110 modules）· 0 secrets · TEST 001-009 PASSED |

### 结论分级（本节不合并）

| 层级 | 结果 | 说明 |
|---|---|---|
| **OFFLINE PASS** | ✅ | typecheck / lint / 单测（201 passed）/ build / scan-secrets / verify-acceptance 全绿 |
| **INTEGRATION PASS** | ✅ | Collector→Repository→Dexie 链路在 `verify-acceptance` 中实测落库（TEST 003/004/005/006） |
| **REAL API PASS** | ⏳ 待低风控环境 | `/x/v2/reply/wbi/main` 等新接口需真实网络复验（1 个 `RUN_REAL_E2E` 门控用例） |
| **REAL API ENVIRONMENT LIMITED** | ✅ 已正确区分 | 无登录态下风控（-352/-412/-509）→ `ok:false` + `environmentLimited`，UI 显示「环境受限」**而非「采集完成 0 条」** |
| **CHROME E2E PASS** | ⏳ 待手动加载 dist/ | 见下方实机验收清单 |

### 用户关键约束遵守情况

- ✅ **没有**「任务→报告→任务→报告」：分组 A–G 批处理后统一验收。
- ✅ **没有**重复安装依赖；**没有**删除 `pnpm-lock.yaml`；**没有**重新 init git。
- ✅ **没有**无关架构重构；**没有**削弱断言以通过测试。
- ✅ **没有** mock 冒充真实 B 站成功，**没有**伪造「采集完成」。
- ✅ **没有**清空 DB（保留历史数据，靠 upsert 比较修复）。

> **已知限制**：真实 B 站端到端（评论游标深分页 / 楼中楼）在无 Cookie 的高风控出口下可能被限制，此时明确标注为「环境受限」。`RUN_REAL_E2E=1` 可在低风控环境手动复验。

---

## 0-quater. V0.1.4 修复（数据迁移 · videoRepo.upsertByBvid 业务字段比较）

> 触发：Chrome 实机（UID 946974 · 影视飓风）在 V0.1.3 修复 normalizer 后**仍然**显示视频「全部 0s / 当天日期」。
> 经排查，根因不是字段映射，而是**数据迁移失败**：V0.1.3 只修了归一化，但 `videoRepo.upsertByBvid()`
> 仍只比较 `title + tags.length` 就返回 `unchanged`，于是历史脏 `Video`（`pubTime=今天`、`duration=0`、`views=null`，
> 由 V0.1.0/V0.1.2 写入）在重新采集时**永远不会被更新**。一句话：**代码修复成功，数据迁移失败**。

| 编号 | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| #1 | P0 | `videoRepo.upsertByBvid()` 仅比较 `title` + `tags.length` 即返回 `unchanged`；`pubTime/duration/views` 等变化被忽略，历史脏数据无法自愈 | 新增 `videoBusinessChanged(a,b)` 比较全部可变业务字段（aid/creatorId/title/description/cover/pubTime/duration/category/url/authorName/authorMid/views/tags）；变化时执行更新 | `tests/repositories/index.test.ts`：新增 2 条回归用例 |
| #2 | P0 | 更新时会把 `createdAt`（首次采集时间）覆盖成新采集时间 | 更新时展开 `video` 后显式保留 `existing.createdAt`、刷新 `updatedAt`、沿用旧主键 `id` | 回归用例断言 `stored.createdAt === dirty.createdAt`（保留首次采集时间） |

**新增回归用例（`tests/repositories/index.test.ts`）**：
- `P0: 旧记录 title+tags 相同但 pubTime/duration/views 变化时必须更新`：`upsert` 脏数据（duration=0/views 缺失）→ 再 `upsert` 正确数据（title/tags 不变，pubTime/duration/views 变）→ 断言 `updated=1`、`unchanged=0`、回读 `pubTime/duration/views` 已纠正、`createdAt` 保留首次采集时间。
- `业务字段完全相同（含 title+tags）时返回 unchanged`：同记录二次 `upsert` → `unchanged=1`、`updated=0`。

**门禁**：typecheck 0 · lint 0 · `pnpm test` **153/153** · build OK · 0 secrets · TEST 001-009 PASSED。
**关键约束（用户明确要求）**：**不通过清空数据库规避代码问题**；修复后由用户在 Chrome 实机对 影视飓风 重新采集一次，确认脏数据被 `upsert` 自愈，而非靠清库。

---

第二轮验收结论：V0.1.1 「工程上基本成型」，但**不算真实 B 站链路验收通过**。本轮按指定范围做最小修复（不做 V0.2、不重做 UI、不做架构重构）。

| 编号 | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| #1 | P0 | `w_rid` 用 SHA-256 截断冒充 MD5，与 B 站要求不等价；且 mixin key 抽取 `(img_url+sub_url).split('/').pop()` 只取到 sub_key | 新增 `src/utils/md5.ts`（RFC 1321 纯 JS）；`w_rid = MD5(query + mixin_key)`；分别取 img/sub 文件名拼接；新增 `buildWbiQuery()` 让签名 query 与请求 URL 同源（含 `!'()*` 过滤） | `tests/utils/md5.test.ts`：RFC 1321 向量 + Node `crypto` 差分（含中文/emoji/10 万字符）；`tests/utils/wbi.test.ts`：w_rid 可复现、参数排序、chr_filter |
| #2 | P0 | 「WBI 失败降级」只在签名函数抛错时触发；B 站风控是 **HTTP 200 + code=-352/403**，不会抛异常 | 新增 `src/utils/bili.ts`（`biliCode` / `isBiliBlocked` / `hasBiliData` / `BILI_REFERRER`）；Creator + Video 两条链路改为「业务码不可用或 data 缺失 → 降级 legacy」 | `tests/collectors/creator.test.ts`：「wbi/acc/info 返回 -352 时降级到 legacy」；`tests/collectors/video.test.ts`：「WBI 接口返回 -352（HTTP 200）时也要降级」 |
| #3 | P0 | 搜索链路缺 bilibili 域 Referer（真实 Chrome 下 412），且未走 WBI 签名 | `http.ts` 新增 `referrer` 透传（Referer 是 forbidden header，只能走 fetch `referrer` init）；搜索 URL 走真实 WBI 签名，签名失败回退未签名，被拦再回退一次 | `tests/utils/bili.test.ts`（Referer 常量）；smoke 用例覆盖 search/type |
| #4 | P0 | Radar 的 UP 列显示字面量 `search`，`play`（播放）被丢弃 | `Video` 新增可选 `authorName` / `authorMid` / `views`；`creatorId` 改 `uid:{mid}`；Radar 新增「播放」列，UP 列显示真实 UP 名，时长改用 `formatDuration` | `tests/collectors/search.test.ts`：断言 `creatorId=uid:67890`、`authorName/authorMid/views` 均保留；无 mid/play 时不伪造 |
| #5 | P1 | Import 只做 `JSON.parse` + `Array.isArray` 就 bulkPut | 12 张表逐条 Zod `safeParse`；非法行跳过并计数；`previewImport` 上报 `counts/invalid/errors`；`applyImport` 返回 `imported/skipped` | `tests/services/export-import.test.ts`：2 个新 case（非法行被跳过 / 绕过 preview 也校验） |
| #6 | P1 | upstat 失败 → `totalViews: 0`，把「未知」伪装成「采集到 0」 | `CreatorSnapshot` totals 改 `number \| null`；`normalizeCreatorTotals` 返回 `null + available=false`；UI `formatInt` 显示 `–` | `tests/normalizers/creator.test.ts` + `tests/collectors/creator.test.ts`：断言 `toBeNull()` |
| #7 | P1 | 评论「本次新增 N 条」用 `r.data.length`（含已存在评论） | `CollectorOk.stats{added,updated,unchanged}`；Comment 页显示「新增 / 已存在 / 抓到」 | `tests/collectors/comment.test.ts`：二次采集 `added=0`、`unchanged=25` |
| #8 | P1 | 5 分钟缓存命中也写 snapshot，污染时间序列 | 新增 `cachedWithMeta()`；命中时 `fetched=false` 且不写快照 | `tests/collectors/creator.test.ts`：命中后快照数不变，清缓存后再采集才 +1 |
| #9 | P1 | HotTopic 每次 `newId('ht')` + bulkPut → 刷新一次多一份 | `hotTopicBusinessId(source,title)`（md5 前 16 位）；bulkPut 变 upsert；repo 返回真实 `added/updated` | `tests/normalizers/hot-topic.test.ts` + `tests/collectors/hot-topic.test.ts`：重复采集行数不变、`added=0 / updated=2` |
| #10 | P1 | smoke test 在 `pnpm test` 里跑 → CI 每次打真实 B 站接口 | `vitest.config.ts` 排除 `tests/smoke/**`；新增 `vitest.smoke.config.ts` + `pnpm test:smoke`；CI 加 `scripts/assert-smoke-isolated.mjs` 守卫；smoke 改 `workflow_dispatch` | `node scripts/assert-smoke-isolated.mjs` ✅；`pnpm test` 136/136 离线 |

**门禁**：typecheck 0 · lint 0 · `pnpm test` 136/136 · `pnpm test:smoke` 4/4 · build OK · 0 secrets · TEST 001-009 PASSED。
**提交与 CI**：commit `737d347`（40 files, +1612/-250）已 push 至 `main`，CI Run #36419334471 ✓ 47s（8/8 steps success，smoke job 按设计 skipped）。

**已知限制（诚实记录）**：WBI 签名的**端到端成功**未能在本机证实。实测：
`view` 与 `upstat` 返回 `code=0`（网络 / UA / Referer 均正常），但**完全不需要签名的 legacy `/x/space/acc/info` 同样返回 -799 / -352**，
说明当前出口 IP 对 space 系列处于整体风控，因此 `wbi/acc/info` 的 -352 不能归因于签名算法。
算法本身的正确性由离线测试保证（RFC 1321 向量 + Node crypto 差分），端到端需在低风控 / 带 Cookie 环境复验。

---

## 0. V0.1.1 修复（独立验收反馈 · 真实数据链路问题）

V0.1 提交后独立验收发现 7 项真实数据链路问题，未要求重构。V0.1.1 按最小修复原则处理：

| 编号 | 问题 | 修复 | 验证 |
|---|---|---|---|
| #1 | CreatorCollector 用已废弃 `/x/space/acc/info` 且 URL 缺少 `?mid={uid}` | 切换到 `/x/space/wbi/acc/info?mid={uid}`，调用 `refreshWbi()` + `signWbi()`，失败降级到 legacy `acc/info` | `tests/collectors/creator.test.ts`：happy path 调用 URL 包含 `wbi/acc/info` + `upstat?mid=` |
| #2 | `/x/space/upstat` 缺少 `?mid={uid}`，无登录态可能失败 | 加 `?mid={uid}`；upstat 失败 → 静默降级（totals=0），creator 仍采集成功 | `tests/collectors/creator.test.ts`："upstat 失败 → creator 仍能采集成功" |
| #3 | VideoCollector 调用 `/x/space/wbi/arc/search` 未接入 WBI | `buildWbiArcSearchUrl()`：`refreshWbi()` + `signWbi({mid,pn,ps,order,platform,web_location,tid,keyword})`，失败降级到带 wts 的请求 | `tests/collectors/video.test.ts`："happy path: wbi/arc/search URL contains wts + w_rid" |
| #4 | Video normalizer 的 duration 只接受 number；真实搜索数据可能是 "MM:SS" 字符串 | 新增 `parseDurationToSeconds()`：`number` / numeric string / `MM:SS` / `HH:MM:SS` → 秒 | `tests/normalizers/video.test.ts`：5 个新 case 覆盖 4 种格式 |
| #5 | SearchCollector 假设 archive API 字段；真实搜索响应结构不同（无 `desc` 用 `description`，无 `tname`，`duration` 是 "MM:SS"，`play` 是 views，`mid/author` 是 UP 信息，title 带 `<em class="keyword">`） | 新增 `normalizeSearchVideo` / `normalizeSearchVideoList` / `stripSearchHighlight` / `parseSearchDuration`；SearchCollector 改用独立归一化 | `tests/collectors/search.test.ts`：21 个新 case（含真实响应结构） |
| #6 | `buildCreatorAnalyzePrompt` 中 `views: v.duration` 是明确字段错误（把 duration 当 views 喂 AI） | 改为 `duration: v.duration`；views 数据由 snapshots 段承担 | `tests/ai/prompts.test.ts`：新增回归测试断言 `recentVideos[0].duration === video.duration` 且无 `views` 字段 |
| #7 | CreatorCollector 返回临时 ID 导致 UI refresh 用错误 ID 查询不到数据 | upsert 后用 `upserted.ids[0]` 作为 persistedId；返回前用 `creatorRepo.findById(persistedId)` 读出真实 Creator | `tests/collectors/creator.test.ts`："返回的 Creator.id 与 DB 中持久化 id 一致"，二次采集 id 不变 |

**真实 API smoke test（新增，命中真实 B 站接口）**：`tests/smoke/real-api.test.ts`

1. `GET /x/web-interface/nav` → 校验 `data.wbi_img.img_url + sub_url` 结构（refreshWbi 依赖）
2. `GET /x/web-interface/search/type?search_type=video&keyword=AI` → 校验 `data.result.video[]` 结构与 `duration` 字符串格式
3. `GET /x/web-interface/view?bvid=BV1GJ411x7h7` → 校验 `data.view / like / reply / danmaku` 字段

默认开启（命中真实网络）；`SKIP_SMOKE=1` 可跳过。状态码校验放宽到 `< 500`（412/429 风控属正常）。

**新增测试覆盖**：6 V0.1.1 单测 case + 3 smoke case，总计 **113/113 PASS（19 files）**。

---

## 1. 功能完成度

| 类别 | 完成项 | 状态 |
|---|---|---|
| 数据模型 | 12 张表（Creator / CreatorSnapshot / Video / VideoSnapshot / Comment / CommentAnalysis / HotTopic / Idea / Topic / Experiment / CollectionTask / AIAnalysis）+ Zod 校验 + Dexie schema v1 + 复合索引 | ✅ |
| 工具层 | id (nanoid+ts 前缀) / time (定长 0 填充) / logger (DEV 检测) / http (timeout+retry+backoff+限流) / cache (TTL) / wbi (降级实现，已注注释) | ✅ |
| 归一化 | 4 个 normalizer，覆盖 happy / malformed / 非 0 code / dedup / mid hash | ✅ |
| 采集 | 5 个 Collector（Creator/Video/Comment/HotTopic/Search），统一接口 + retryable + dedup by 业务键 | ✅ |
| AI | 4 Adapter（OpenAI-compatible / DeepSeek / Gemini / Custom）+ Service + 3 类 prompt（账号/视频/评论，全部强制三段式 facts/explanations/uncertainty） | ✅ |
| UI | popup（自动识别当前页 + 6 页入口） + options（Provider 配置 + 测试连接 + 清空） + 6 个 page（creator/radar/comment/my/hot/idea） + content（URL 路由监听 + 浮动按钮） + background SW | ✅ |
| 服务 | JSON 全量导出 / JSON 导入（preview + validate + merge/replace） / CSV 导出 | ✅ |
| 安全 | chrome.storage / localStorage 隔离 API Key；scan-secrets.mjs；.gitignore 覆盖 .env / SESSDATA / Token | ✅ |
| 文档 | SPEC / README / LICENSE / NOTICE / OPEN_SOURCE_AUDIT / ARCHITECTURE / DATA_POLICY / CHANGELOG / DEVELOPMENT / PROGRESS / FINAL_AUDIT | ✅ |
| CI | GitHub Actions：install + typecheck + lint + test + build + secret-scan + 上传 dist 产物 | ✅ |
| **未做** | 全站雷达的真正 50w+ UP 主索引、爆款百分比预测、AI 自动剪辑 / 发布、跨平台、多账号、付费 | ❌（按原始指令 §40 显式不做） |

---

## 2. 测试

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `tsc --noEmit` | **0 errors** |
| Lint | `eslint src/**/*.{ts,tsx} tests/**/*.{ts,tsx}` | **0 errors / 0 warnings** |
| 单元 + 集成 | `vitest run` | **113/113 PASS（19 test files，含 V0.1.1 新增 6 单测 + 3 smoke）** |
| 自动验收 | `pnpm verify-acceptance` | **TEST 001-009 PASS**（TEST 010/011 deferred — 见下） |
| Secret scan | `node scripts/scan-secrets.mjs` | **0 leaks** |
| Build | `vite build` | **成功（59 个产物文件，含 popup/options/6 pages/background/content/icons）** |

### 测试覆盖

- `utils/id.ts`：4 test — 唯一性 / 前缀 / 长度
- `utils/time.ts`：10 test — ISO / seconds / duration（4 格式）/ int
- `utils/http.ts`：7 test — JSON 解析 / 非 JSON / 5xx / abort / POST / network retry
- `utils/cache.ts`：覆盖在 collector 测试中
- `normalizers/creator.ts`：5 test — happy / throws / defaults / totals
- `normalizers/video.ts`：6 test — vlist 两路径 / non-zero code / skip invalid / stat
- `normalizers/comment.ts`：5 test — happy / non-zero / dedup / maxItems / mid→32 hex
- `normalizers/hot-topic.ts`：3 test — happy / non-zero / search
- `content/detect.ts`：6 test — space/video/search URL + bvidToAid
- `collectors/creator.ts`：4 test — happy / invalid uid / network failure / malformed
- `collectors/video.ts`：(走 acceptance TEST 003)
- `collectors/comment.ts`：2 test — 不存在视频 / happy
- `collectors/hot-topic.ts`：2 test — top / search
- `repositories/index.ts`：5 test — creator / video / idea CRUD + upsert 幂等
- `ai/openai-adapter.ts`：4 test — JSON-mode / HTTP error / connect ok / connect throw
- `ai/service.ts`：4 test — 无 provider 抛错 / connect / analyze 写行 / setProviderConfig 持久化
- `ai/prompts.ts`：3 test — 三段式强制 / 反预测 / 反词云幻觉
- `services/export-import.ts`：3 test — round-trip / 无效 JSON / CSV 转义

### 自动验收（原始指令 §36）

| ID | 描述 | 结果 |
|---|---|---|
| TEST 001 | 输入 UP 主 UID → 账号信息正常 | ✅ PASS（name=tester, followers=12345） |
| TEST 002 | 进入视频页 → 自动识别 BV 号 | ✅ PASS（detectFromUrl 返回 bvid） |
| TEST 003 | 分析视频 → 视频数据正常 | ✅ PASS（views=10000, likes=500, snapshot 写入） |
| TEST 004 | 采集评论 → Comment 正常写入 Dexie | ✅ PASS（25 条全部入库） |
| TEST 005 | 重复采集 → 不会产生大量重复记录 | ✅ PASS（delta=0，rpids 幂等） |
| TEST 006 | CreatorSnapshot → 第二次采集能够产生新的时间点 | ✅ PASS（before=1 after=2） |
| TEST 007 | 数据查询 → 可以按时间查看 | ✅ PASS（n=2, monotonic=true） |
| TEST 008 | AI 连接测试 → 能成功调用配置模型 | ✅ PASS（aiAnalyze / aiTestConnection 已实现，单元测试覆盖 happy/401/connection failure） |
| TEST 009 | AI 分析失败 → 不会产生假结果 | ✅ PASS（OpenAICompatibleAdapter.analyze throws on non-2xx，无 fallback，无空文本写入） |
| TEST 010 | git status 干净 | ✅ PASS（commit 后立即检查，git status --short 为空） |
| TEST 011 | CI 绿色 | ✅ PASS（GitHub Actions Run #36411153975，1m4s，✓ main CI · verify） |

---

## 3. GitHub

- 仓库名：**BiliScope**
- 类型：**Private**
- URL：https://github.com/SHUMLU0/BiliScope
- 本地提交：`9a1f248 chore: initial commit (BiliScope V0.1)` — 116 文件 / 12,281 insertions
- CI：✅ GitHub Actions Run #36411153975（1m4s，✓ verify）
- 产物：biliscope-dist artifact 已上传

---

## 4. 数据采集

| 接口 | 公开 | 鉴权 | 用法 | V0.1.1 状态 |
|---|---|---|---|---|
| `/x/space/acc/info` | ✅ | ❌ | 账号基础信息（legacy 兜底） | 加 `?mid={uid}`；仅在 WBI 失败时降级使用 |
| `/x/space/wbi/acc/info` | ✅ | WBI | 账号基础信息（new 主链路） | V0.1.1：先 refreshWbi + signWbi |
| `/x/space/upstat` | ✅ | ❌ | 账号总播放 / 点赞 | V0.1.1：加 `?mid={uid}` + 失败非致命（totals=0） |
| `/x/web-interface/nav` | ✅ | ❌ | 拉 wbi_img | V0.1.1：refreshWbi 调用 |
| `/x/space/wbi/arc/search` | ✅ | WBI | UP 主视频列表 | V0.1.1：先 refreshWbi + signWbi |
| `/x/web-interface/view` | ✅ | ❌ | 单视频元数据 + 实时统计 | 不变 |
| `/x/v2/reply` | ✅ | ❌ | 评论（楼中楼 / IP 属地需要登录态，V0.1 仅取 uname / content / like / ctime） | 不变 |
| `/x/web-interface/ranking/v2` | ✅ | ❌ | 全站热门 | 不变 |
| `/x/web-interface/search/square` | ✅ | ❌ | 热搜词 | 不变 |
| `/x/web-interface/search/type` | ✅ | ❌ | 关键字搜索（V0.1 雷达使用） | V0.1.1：新增 `normalizeSearchVideoList` 处理真实响应结构（`<em>` 高亮剥离、`duration` 字符串解析、无 `tname`） |

**未使用**：SESSDATA / bili_jct / 任何登录态；WBI 签名有占位实现（已注释说明生产替换方法）。

---

## 5. AI Provider

| Provider | 实现 | 测试 | Key 存储 |
|---|---|---|---|
| OpenAI-compatible | ✅ OpenAICompatibleAdapter | ✅ 4 test | chrome.storage.local / localStorage |
| DeepSeek | ✅ 复用 OpenAI-compatible（DeepSeek = OpenAI 兼容协议） | ✅ 同上 | 同上 |
| Gemini | ✅ GeminiAdapter（generativelanguage.googleapis.com） | ⚠️ 未单独单测（环境无 Key），但代码已实现 | 同上 |
| Custom | ✅ 同 OpenAI-compatible + extraHeaders | ✅ 同上 | 同上 |

---

## 6. 开源审计（详见 OPEN_SOURCE_AUDIT.md）

| 项目 | License | 状态 |
|---|---|---|
| Bili-Insights (dai-hongtao) | MIT | 参考架构；不复制源码 |
| YourBili (miaoihan) | CC BY-NC 4.0 | 参考 WBI 思路；禁止商用，不复制 |
| BilibiliCrawler (Yi-luo-hua) | MIT | 参考架构；不复制源码 |
| bilibili-comment-analyzer (sansan0) | GPL-3.0 | 仅参考功能；不复制（MIT 不兼容 GPL） |
| BiliInsight (2951121599) | CC BY-NC-SA 4.0 | 已停滞 ~2 年；仅参考 UI；不复制 |
| bilibili-api-collect (bilibili-plugins) | CC-BY-NC 4.0 | 仅作端点参考；不复制 |

**全部最终代码均为本项目独立编写**。NOTICE 文件已记录每个项目 + 复用方式。

---

## 7. 风险与已知限制

1. **WBI 签名**（V0.1.2 已修复算法，端到端待复验）：`utils/wbi.ts` 已改为真正的纯 JS MD5（`src/utils/md5.ts`），
   `w_rid = MD5(query + mixin_key)`，与 B 站要求字节等价。但本机出口 IP 对 space 系列整体风控
   （连无签名的 legacy `acc/info` 都返回 -799 / -352），**端到端成功未证实**，需在低风控环境复验。
   详见 §0-bis「已知限制」。
2. **评论 IP 属地缺失**：B 站评论 IP 属地接口要求登录态（X-Bili-Mid 之类）。V0.1 按 §7「不读 Cookie / 不登录」原则显式不做。
3. **全站雷达为阶段 1**：未做 50w+ UP 主结构化索引，仅支持搜索 + 榜单 + 收藏列表入口。V0.2 路线图中实现。
4. **icon 占位**：4 个 PNG 是 scripts/generate-icons.mjs 生成的纯色占位（不含设计）。仅满足 Manifest V3 必填。
5. **Gemini Adapter 未单测**：环境无 Key，单元测试无法实际跑通 HTTP。代码已实现 + 类型完整，真实部署需要真实 Key 跑一次连通性。
6. **ci 暂未运行**：本机无 `gh` CLI 可用 → 无法在 push 前预演 CI。但 typecheck/lint/test/build/secret-scan 全部已在本机跑通。

---

## 8. 当前技术债（下一阶段前必须解决）

| 编号 | 问题 | 修复建议 |
|---|---|---|
| TD-01 | ~~WBI 降级实现~~ | ✅ V0.1.2 已解决（纯 JS MD5 + nav 拉 mixin_key）。剩余：端到端需低风控环境复验 |
| TD-02 | icon 是纯色占位 | 重新设计 / 找设计师 |
| TD-03 | 全站雷达未做 50w+ 索引 | V0.2 引入按分类 / 标签的 Creator Index |
| TD-04 | `formatDuration` 不区分 minute / hour / day 的 locale | 后续按 i18n 抽出 |
| TD-05 | search collector 未限频（容易被 B 站风控） | 引入按关键词的 TTL + queue |
| TD-06 | `service.ts` 的 `analyze` 在模型返回 `jsonMode` 失败时静默 | 显式报错 |
| TD-07 | Popup UI 没做 mobile 适配 | popup 通常固定宽度，但 future-proof |

---

## 0-ter. V0.1.3 修复（Chrome 实机验收 · 归一化字段映射）

> 本轮由独立审计员**实际在 Chrome 里加载 V0.1.2 的 dist** 采集 UID 946974（影视飓风）触发。
> 关键结论（原文）：**"不是'B站没采到数据'，而是'采到了数据，但归一化字段映射错了'"** ——
> 粉丝=0、关注=0、投稿=0、趋势快照全 0、视频发布时间全显示今天、时长全 0s。
>
> 本轮严格遵守执行原则：**先读真实 API，再决定字段映射**。新增 `scripts/probe-real-api.ts`，
> 把真实响应落盘到 `tests/fixtures/real/`（14 份），所有字段映射均源于此，未用任何 mock 数据伪造真实接口成功。

### 修复清单（P0 × 6 + P1 × 5）

| 编号 | 级别 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| #1 | P0 | Creator 计数器被 `?? 0` 强制成 0；真实 `/x/space/wbi/acc/info` 用 `fans/attention/archive_count`，非 `following/archive_count` | 三级来源：`wbi/acc/info` → `legacy acc/info` → `/x/web-interface/card`（`mid` 为字符串、`following` 为布尔）；补充 `/x/relation/stat`(follower/following) + `/x/space/navnum`(video)；彻底删除 `?? 0`，未知一律 `null` | `tests/normalizers/creator.test.ts`：缺失→null 非 0；真实 `wbi/acc/info` 的 `fans/attention/archive_count`；`relation/stat` + `navnum` 用例 |
| #2 | P0 | `CreatorSnapshot.followers/following/videoCount` 不可空，强制 0 | schema 改 `number \| null`；UI 显示 `–` | 同上 |
| #3 | P0 | `VideoNormalizer` 读 `pubdate`/`duration`，缺失回退 `Date.now()` 与 `0` | 真实列表字段 `created`(时间戳)/`length`("12:34")/`play`/`author`/`mid`；`duration` 解析不出→`null`，`pubTime` 用 `created`/`pubdate`，**绝不回退 `Date.now()`** | `tests/normalizers/video.test.ts`：length→duration、created→pubTime（断言≠今天）、play→views、author→authorName、mid→authorMid、garbage→null |
| #4 | P0 | Normalizer 测试只覆盖 mock，未用真实结构 | 新增 `tests/fixtures/real/arc-search-wbi.json`（真实 `created/length/play/author/mid`），四个断言全部基于真实字段 | 同上 |
| #5 | P0 | `VideoCollector` 对每个视频（约 210 个）逐个请求 `/view` | 默认 `fetchDetails=false`；列表自带 `play`→初始 `VideoSnapshot`（其余 null）；仅在显式要求时补详情且受 `maxDetailFetches` 限制 | `tests/smoke/e2e-chain.test.ts`：断言 `detail view requests = 0`；日志 `list requests=N, detail view requests=0` |
| #6 | P0 | Video 稳定字段与时效指标混在一起，无法回答"发布时 vs 现在" | 拆分：`Video`（bvid/aid/title/author/pubTime/duration/category/tags/creatorId）与 `VideoSnapshot`（views/likes/coins/favorites/shares/comments/danmaku，均 `number \| null`） | `src/models/video.ts` schema 拆分 |
| #7 | P1 | SearchCollector 假设 `data.result.video`，真实是数组 | 真实 `search/type` 的 `data.result` 为**数组**；端点 `/x/web-interface/wbi/search/type`→降级 `/search/type`→未签名；保留 bvid/aid/mid/author/title/description/play/duration/pubdate/tag | `tests/collectors/search.test.ts`：真实数组结构用例 |
| #8 | P1 | HTTP 5xx 永不重试（catch 里无条件 `status:undefined` 抹掉 5xx） | 仅在无 status 时置 undefined；`retryable` 正确；指数退避 | `tests/utils/http.test.ts`：`503→503→200` 成功、`503×4` 失败、status/retryable 保留 |
| #9 | P1 | Import 先 `clear` 再发现数据坏了 | 先全量 Zod 校验，任一非法则**整体拒绝**（旧数据不动）；全部合法才单事务 `clear+bulkPut` | `tests/services/export-import.test.ts`：`replace 整体拒绝` + 全合法事务用例 |
| #10 | P1 | Smoke 把风控失败也叫 PASS | 语义三态 `PASS`/`PASS_WITH_ENV_LIMIT`/`FAIL`；新增 `tests/smoke/classify.ts` + 真实 E2E 链路 | `tests/smoke/real-api.test.ts` + `e2e-chain.test.ts` |
| #11 | P1 | 版本号散落不一致 | package.json / manifest.json / DEPLOYMENT / CHANGELOG / FINAL_AUDIT / PROGRESS 全部对齐 **V0.1.3** | 见各文件 |

### 最终验收结论（严格分级，不合并）

| 类别 | 结论 | 依据 |
|---|---|---|
| **① 离线单测通过** | ✅ | `vitest run` **151/151 PASS**（21 文件）；typecheck 0 · lint 0 · build OK · 0 secrets · TEST 001-009 PASSED |
| **② 真实 API 可验证（离线用真实抓取响应）** | ✅ | `tests/fixtures/real/` 14 份真实响应（nav / wbi acc/info / legacy / card / upstat / arc-search×2 / search-type×3 / relation-stat / navnum / view …）驱动的 normalizer + collector 用例全部通过；证明**字段映射已对齐真实 B 站结构** |
| **③ 真实 API 受风控无法验证（匿名 + 无 Cookie 出口）** | ⚠️ 诚实保留降级 | 实机/自动化探测显示：本机出口对 space 系列整体风控 —— `wbi/acc/info` 返回 `code=-352`、`legacy acc/info` 返回 `-799`、`wbi/arc/search` 返回 `HTTP 412`。已用匿名可用的 `/x/web-interface/card` + `/x/relation/stat` + `/x/space/navnum` 作为补充来源拿到真实 粉丝/关注/投稿/等级，但**全量视频列表在无 Cookie 时仍可能拿不全** |
| **④ Chrome 实机验收（UID 946974）** | ⏳ 待用户手动加载 dist 确认 | 见下方「实机验收清单」；本轮代码产物已通过 ①+②，③ 的降级路径已实测可用（smoke 显示 `uid=946974 followers=18443072 following=686 videoCount=946 level=6`） |

### 实机验收清单（Chrome 加载 `dist/` 后逐项核对）

1. 影视飓风主页：粉丝 = 真实非零（≈18,443,072）；关注 / 投稿 = 真实值或 `–`（绝不 0 伪装）；等级 = 真实（6）。
2. 趋势快照：无伪造 0 点；仅在有真实数据时落点。
3. 视频列表：标题真实；发布时间为真实日期（**非全部"今天"**）；时长为真实秒数（**非全部 "0s"**）。
4. Radar 页：标题 / UP 名 / 播放量 / BVID / 时长 均来自真实字段（**UP 不得显示 `search`**）。

> 注：本轮 CI / 自动化已证明 ① + ② + ③ 降级路径可用；④ 需用户在真实 Chrome 环境加载 `dist/` 做最终肉眼确认，审计方不得代签。

**门禁顺序固定**：typecheck → test → lint → build → secret-scan → acceptance → git status → commit → push → CI。


## 9. 下一阶段建议（V0.2）

1. 实现 `Creator Index` —— 按分类 / 标签 增量构建 UP 主索引；UI 提供二级入口（赛道结构）。
2. 接入真实 WBI 签名（TD-01）。
3. 引入 `outlierRatio` 与历史基线对比的「历史异常表现」算法（指令 §19）。
4. 实验闭环（V0.3 占位）：Idea → Topic → Experiment 三态完整化（指令 §43）。
5. CI 跑通后，把 73 个单元测试扩展到覆盖率 70%+（V0.1 覆盖率统计未跑，避免占用额外资源）。

---

## 10. 最终门禁总结

### V0.1.2（本轮）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ 136 passed (21 files) EXIT=0（离线，不含 smoke） |
| `pnpm test:smoke` | ✅ 4 passed（真实网络，手动执行） |
| `node scripts/assert-smoke-isolated.mjs` | ✅ OK（smoke 未回灌默认测试） |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED（010/011 deferred） |
| `git push → CI` | ✅ commit `737d347` → `https://github.com/SHUMLU0/BiliScope/actions/runs/36419334471` ✓ 47s（8/8 steps success，smoke job skipped） |

### V0.1.1（上一轮）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ 113 passed (19 files) EXIT=0 |
| `pnpm build` | ✅ EXIT=0（59 files in dist/） |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED（010/011 deferred） |
| `git push → CI` | ✅ `https://github.com/SHUMLU0/BiliScope/actions/runs/36413095312` ✓ 35s |