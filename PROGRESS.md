# BiliScope V0.1 进度表

> 唯一进度表（Single Source of Truth）。
> 状态：✅ 完成 / 🔄 进行中 / ⏸ 阻塞 / ⬜ 未开始

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

## 下一阶段（不在 V0.1 / V0.1.1 / V0.1.2 范围）

- V0.2：50w+ Creator Index + 实验闭环 + 榜单时序（快照语义）索引
- WBI 端到端成功仍需有 Cookie / 低风控出口的环境复验（见 `FINAL_AUDIT.md` § 10 已知限制）
- 详见 `FINAL_AUDIT.md` § 8 § 9