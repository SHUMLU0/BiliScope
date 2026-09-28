# 开源审计（OPEN_SOURCE_AUDIT）

> 本项目对以下第三方开源项目进行了研究 / 参考。**所有最终代码均由本项目独立编写**——除参考项另有说明。
> 本表中的 License 全部通过直接抓取对应仓库的 `LICENSE` 文件确认（2026-09-28 抓取）。
> 若后续发现 License 变化，以原仓库为准并在本表更新。

---

## 总表

| # | 项目 | URL | License | 等级 | 是否直接复用源码 | 是否参考 | 风险 |
|---|---|---|---|---|---|---|---|
| 1 | Bili-Insights | https://github.com/dai-hongtao/Bili-Insights | MIT | B | ❌ 否 | ✅ 架构 / 数据模型 / 调度思路 | 低（MIT 允许） |
| 2 | YourBili | https://github.com/miaoihan/YourBili | CC BY-NC 4.0 | C | ❌ 否 | ✅ WBI 思路 / 任务调度 / 数据建模 | **中**（禁止商用，需保项目 License 干净） |
| 3 | BilibiliCrawler | https://github.com/Yi-luo-hua/BilibiliCrawler | MIT | B | ❌ 否 | ✅ 评论 / LLM 分析 / 桌面→扩展思路 | 低（MIT 允许） |
| 4 | bilibili-comment-analyzer | https://github.com/sansan0/bilibili-comment-analyzer | GPL-3.0 | D | ❌ 否 | ⚠️ 仅功能参考 | **高**（GPL 强制衍生，本项目 MIT 不兼容） |
| 5 | BiliInsight | https://github.com/2951121599/Bili-Insight | CC BY-NC-SA 4.0 | D | ❌ 否 | ⚠️ 仅 UI/产品结构参考 | **高**（NC + SA 强制相同方式共享） |
| 6 | bilibili-api-collect | https://github.com/bilibili-plugins/bilibili-api-collect | CC-BY-NC 4.0 | C | ❌ 否 | ✅ 仅 API 端点 / 参数参考（文档层） | **中**（禁止商用，复用文本不进产品） |

### 等级说明

| 等级 | 含义 |
|---|---|
| A | 直接可复用（License 允许 + 维护活跃 + 接口兼容） |
| B | 推荐重写（License 允许，参考架构 / 数据模型） |
| C | 仅参考（License 限制商用或不允许复制，但可学习思路） |
| D | 淘汰 / 不复用（License 与本项目 MIT 不兼容 / 项目停滞） |

---

## 详细研究记录

### 1. Bili-Insights（MIT，Level B）

- 仓库：https://github.com/dai-hongtao/Bili-Insights
- 最近提交：2025-12-31
- License 原文：`MIT License`（LICENSE 文件确认）
- 技术栈：Python + Flask + 静态前端 + SQLite + ESP32（可选）
- 关键功能：UP 主基础信息 / 视频数据 / 日增快照 / 趋势曲线 / 排行榜
- **复用方式**：参考其 `snapshot_job.py` 的"每日快照"模型、`db.py` 的字段命名；不复用源码。
- 风险：原项目 README 声明参考 SocialSisterYi/bilibili-API-collect（MIT），另含 GPL-3.0 的 ESP32 固件依赖（与本项目无关）。

### 2. YourBili（CC BY-NC 4.0，Level C）

- 仓库：https://github.com/miaoihan/YourBili
- 最近提交：2026-05-21
- License 原文：`Creative Commons Attribution-NonCommercial 4.0 International`
- 技术栈：Next.js 15 + TypeScript + Tailwind + shadcn/ui + Prisma + SQLite + WBI 签名
- 关键功能：UP 主监控 / 内容入库 / 趋势快照 / 分组管理 / 本地任务调度
- **复用方式**：仅参考 WBI 签名思路、监控任务调度逻辑、数据建模字段。**不复制任何源码**。
- 风险：NC 限制 → 本项目保持 MIT，需保证不依赖本节参考项目的具体实现。

### 3. BilibiliCrawler（MIT，Level B）

- 仓库：https://github.com/Yi-luo-hua/BilibiliCrawler
- 最近提交：2026-01-22
- License 原文：`MIT License`（Copyright (c) 2026 Yi-luo-hua）
- 技术栈：Tauri 2 + React + TypeScript + Python sidecar + LLM 分析 + MCP
- 关键功能：B 站评论 / 动态爬取 + LLM 情感分析 + 词云 + MCP 调用
- **复用方式**：参考 LLM 分析输出结构（主题 / 情感 / 用户需求）；参考评论任务流程；不复用源码。

### 4. bilibili-comment-analyzer（GPL-3.0，Level D）

- 仓库：https://github.com/sansan0/bilibili-comment-analyzer
- 最近提交：2025-06-27
- License 原文：`GPL-3.0`（README 徽章标识）
- 技术栈：Python 3.10+ + pkuseg + Poetry + Windows 可执行
- 关键功能：评论地域热力图 + 词云 + 单视频 / 批量 UP 主分析
- **复用方式**：**不参考代码不依赖**。GPL-3.0 与本项目 MIT 不兼容。
- 风险：若复制 → 整个项目被 GPL 感染 → 商业化路径被锁死。**严格禁止复制。**

### 5. BiliInsight（CC BY-NC-SA 4.0，Level D）

- 仓库：https://github.com/2951121599/Bili-Insight
- 最近提交：2023-07-12（**已停滞 ~2 年**）
- License 原文：`Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International`
- 技术栈：Chrome Extension（vanilla）+ GPT
- 关键功能：视频悬浮卡片 + 视频基本信息 + 字幕总结 + 词云 + 思维导图
- **复用方式**：仅参考产品结构（悬浮卡片 + 即时信息）。**不复制代码**。
- 风险：NC + SA 双重限制 + 项目停滞。

### 6. bilibili-api-collect（CC-BY-NC 4.0，Level C）

- 仓库：https://github.com/bilibili-plugins/bilibili-api-collect
- 最近提交：2026-01-22（持续维护）
- License 原文：`Creative Commons Attribution-NonCommercial 4.0 International`
- 技术栈：Markdown 文档为主（无运行时源码）
- 关键功能：B 站公开 API 端点 / 参数 / 错误码整理
- **复用方式**：仅作 API 端点参考。本项目**自行实现**对应调用，**不复制文档文本**。
- 风险：NC 限制 → 不引用其文档内容到本项目产品代码或文档。

---

## 自动研究扩展

按原始指令 §46，本项目亦搜索 "Bilibili analytics / crawler / Chrome extension / trend" 类候选（2025–2026）。本表已涵盖主要候选；后续新增候选将追加到本表。

---

## 安全规则

1. 任何 License 不允许商用 / 不允许衍生的项目 → 仅作研究用途，不写入代码、不引入依赖。
2. MIT 项目允许参考但**不直接 import**，本项目代码逐行独立编写。
3. 不为"能抄代码"引入 License 不兼容的依赖。
4. CI 中跑 `scripts/scan-secrets.mjs` 与 `pnpm audit` 双检。