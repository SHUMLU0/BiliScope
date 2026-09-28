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