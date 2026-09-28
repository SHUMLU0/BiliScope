# BiliScope V0.1 进度表

> 唯一进度表（Single Source of Truth）。
> 状态：✅ 完成 / 🔄 进行中 / ⏸ 阻塞 / ⬜ 未开始

---

## 总体进度（最终态 · 全部完成）

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
| 自动验收（TEST 001-011） | ✅ | **11/11 PASS**（含 GitHub Actions CI） |
| GitHub 仓库创建 + push | ✅ | **https://github.com/SHUMLU0/BiliScope** |
| FINAL_AUDIT.md | ✅ | 已生成并更新 |

---

## 最终门禁

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

## 下一阶段（不在 V0.1 范围）

- V0.2：WBI 真实签名 + 50w+ Creator Index + 实验闭环
- 详见 `FINAL_AUDIT.md` § 8 § 9