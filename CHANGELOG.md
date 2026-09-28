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