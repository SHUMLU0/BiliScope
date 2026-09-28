# BiliScope V0.1 进度表

> 唯一进度表（Single Source of Truth）。
> 状态：✅ 完成 / 🔄 进行中 / ⏸ 阻塞 / ⬜ 未开始

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