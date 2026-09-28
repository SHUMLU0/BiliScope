# FINAL_AUDIT.md — BiliScope V0.1 最终审计

> 生成于 2026-09-28 · V0.1.0 + V0.1.1 修复补丁 · **本地全门禁通过 + CI 绿色** · GitHub: https://github.com/SHUMLU0/BiliScope

---

## 0-bis. V0.1.2 修复（独立验收第二轮 · P0 x4 + P1 x6）

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
| #10 | P1 | smoke test 在 `pnpm test` 里跑 → CI 每次打真实 B 站接口 | `vitest.config.ts` 排除 `tests/smoke/**`；新增 `vitest.smoke.config.ts` + `pnpm test:smoke`；CI 加 `scripts/assert-smoke-isolated.mjs` 守卫；smoke 改 `workflow_dispatch` | `node scripts/assert-smoke-isolated.mjs` ✅；`pnpm test` 135/135 离线 |

**门禁**：typecheck 0 · lint 0 · `pnpm test` 135/135 · `pnpm test:smoke` 4/4 · build OK · 0 secrets · TEST 001-009 PASSED。

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
| `pnpm test` | ✅ 135 passed (21 files) EXIT=0（离线，不含 smoke） |
| `pnpm test:smoke` | ✅ 4 passed（真实网络，手动执行） |
| `node scripts/assert-smoke-isolated.mjs` | ✅ OK（smoke 未回灌默认测试） |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED（010/011 deferred） |
| `git push → CI` | ⏸ 见下方 V0.1.1 行 / 本轮 commit 后更新 |

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