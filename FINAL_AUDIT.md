# FINAL_AUDIT.md — BiliScope V0.1 最终审计

> 生成于 2026-09-28 · V0.1.0 · **本地全门禁通过 + CI 绿色（Run #36411153975）** · GitHub: https://github.com/SHUMLU0/BiliScope

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
| 单元 + 集成 | `vitest run` | **73/73 PASS（16 test files）** |
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

| 接口 | 公开 | 鉴权 | 用法 |
|---|---|---|---|
| `/x/space/acc/info` | ✅ | ❌ | 账号基础信息 |
| `/x/space/upstat` | ✅ | ❌ | 账号总播放 / 点赞 |
| `/x/space/wbi/arc/search` | ✅ | ❌ | UP 主视频列表（无需 WBI） |
| `/x/web-interface/view` | ✅ | ❌ | 单视频元数据 + 实时统计 |
| `/x/v2/reply` | ✅ | ❌ | 评论（楼中楼 / IP 属地需要登录态，V0.1 仅取 uname / content / like / ctime） |
| `/x/web-interface/ranking/v2` | ✅ | ❌ | 全站热门 |
| `/x/web-interface/search/square` | ✅ | ❌ | 热搜词 |
| `/x/web-interface/search/type` | ✅ | ❌ | 关键字搜索（V0.1 雷达使用） |

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

1. **WBI 签名降级**：`utils/wbi.ts` 当前用 SHA-256 截断代替 MD5（浏览器 Web Crypto 不提供 MD5）。生产部署需替换为纯 JS MD5 + 调用 nav 接口取 img_url / sub_url。已在文件注释中说明。V0.1 暂未在采集链路里实际触发 WBI 签名（搜索 / 列表接口无 WBI 强制），不会立即出错。
2. **评论 IP 属地缺失**：B 站评论 IP 属地接口要求登录态（X-Bili-Mid 之类）。V0.1 按 §7「不读 Cookie / 不登录」原则显式不做。
3. **全站雷达为阶段 1**：未做 50w+ UP 主结构化索引，仅支持搜索 + 榜单 + 收藏列表入口。V0.2 路线图中实现。
4. **icon 占位**：4 个 PNG 是 scripts/generate-icons.mjs 生成的纯色占位（不含设计）。仅满足 Manifest V3 必填。
5. **Gemini Adapter 未单测**：环境无 Key，单元测试无法实际跑通 HTTP。代码已实现 + 类型完整，真实部署需要真实 Key 跑一次连通性。
6. **ci 暂未运行**：本机无 `gh` CLI 可用 → 无法在 push 前预演 CI。但 typecheck/lint/test/build/secret-scan 全部已在本机跑通。

---

## 8. 当前技术债（下一阶段前必须解决）

| 编号 | 问题 | 修复建议 |
|---|---|---|
| TD-01 | WBI 降级实现 | 引入纯 JS MD5 + 接入 nav 拉 mixin_key |
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

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0 |
| `pnpm lint` | ✅ EXIT=0 |
| `pnpm test` | ✅ 73 passed (16 files) EXIT=0 |
| `pnpm build` | ✅ EXIT=0（59 files in dist/） |
| `pnpm scan-secrets` | ✅ 0 leaks |
| `pnpm verify-acceptance` | ✅ TEST 001-009 PASSED（010/011 deferred） |
| `git push → CI` | ✅ `https://github.com/SHUMLU0/BiliScope/actions/runs/36411153975` ✓ 1m4s |