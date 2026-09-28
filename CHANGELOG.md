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
- 全站雷达（Page 2）分阶段实施，V0.1 仅支持搜索/筛选入口。