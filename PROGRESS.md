# BiliScope V0.1 进度表

> 唯一进度表（Single Source of Truth）。
> 状态：✅ 完成 / 🔄 进行中 / ⏸ 阻塞 / ⬜ 未开始

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
| 10) commit + push + CI 绿色 | 🔄 | 进行中 |

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
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED（010/011 commit 后验证） |

---

## 下一阶段（不在 V0.1 / V0.1.1 范围）

- V0.2：WBI 真实 MD5 签名 + 50w+ Creator Index + 实验闭环
- 详见 `FINAL_AUDIT.md` § 8 § 9