# 更新日志（CHANGELOG）

本项目遵循 [Semantic Versioning](https://semver.org/) 规范。

## [Unreleased]

### Added

- 项目骨架与文档（README/LICENSE/NOTICE/ARCHITECTURE/DATA_POLICY/OPEN_SOURCE_AUDIT/CHANGELOG/DEVELOPMENT）
- SPEC.md 工程规格
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