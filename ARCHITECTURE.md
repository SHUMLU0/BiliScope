# 架构设计（ARCHITECTURE）

## 总览

```
┌─────────── UI Layer (React) ───────────┐
│ popup / options / pages(6) / components │
└────────────────┬───────────────────────┘
                 │ hooks (zustand stores)
┌────────────────▼───────────────────────┐
│        Application Services Layer      │
│  AnalysisService / ExportService /     │
│  ImportService / TaskScheduler /       │
│  AIAnalysisService                     │
└────────────────┬───────────────────────┘
                 │
┌────────────────▼───────────────────────┐
│      Collector / Analyzer Layer        │
│  CreatorCollector / VideoCollector /   │
│  CommentCollector / HotTopicCollector /│
│  SearchCollector / GrowthAnalyzers    │
└────────────────┬───────────────────────┘
                 │ normalize()
┌────────────────▼───────────────────────┐
│           Repository Layer             │
│  CreatorRepo / VideoRepo / CommentRepo │
└────────────────┬───────────────────────┘
                 │ dexie ops
┌────────────────▼───────────────────────┐
│      Dexie (IndexedDB) — 12 tables     │
└────────────────────────────────────────┘

并行：
┌────────────── AI Layer ─────────────────┐
│  AI Service → Provider Adapter          │
│  ├ OpenAICompatibleAdapter              │
│  ├ DeepSeekAdapter                      │
│  ├ GeminiAdapter                        │
│  └ CustomAdapter                        │
└─────────────────────────────────────────┘
```

## 关键设计原则

1. **UI 不直连 Bilibili API**：UI 调用 Service，Service 调用 Collector，Collector 走 utils/http。
2. **AI 不读 DOM**：AI 只读取 Normalizer 之后的结构化数据。
3. **数据层与 UI 解耦**：通过 zustand store 暴露只读视图，UI 不直接写 IndexedDB。
5. **增量采集**：首次全量，之后只取新增 / 变化。
4. **可降级**：所有外部依赖（AI、Bilibili 接口）失败时，UI 仍能展示本地已有数据。

## 关键流程：打开 B 站 UP 主空间

```
content script 注入
   │ 检测 URL 匹配 /space.bilibili.com/\d+/
   │ 提取 uid
   ▼
popup 打开
   │ 选择"账号研究"
   ▼
CreatorCollector.collect({ uid })
   │ GET https://api.bilibili.com/x/space/acc/info?mid={uid}
   │ normalize → Creator
   ▼
Repository.save(Creator)
   │
   ├─ 首次：全量保存
   └─ 后续：Creator 字段有变化则更新，并写入 CreatorSnapshot
   ▼
UI 渲染 CreatorSnapshot 趋势 + 视频列表
```

## 关键流程：AI 账号分析

```
用户在账号研究页点击"AI 分析"
   │
   ▼
AIAnalysisService.analyzeCreator({ creatorId })
   │ 拉取 Creator + 最近 N 个 Video + 最近 N 个 VideoSnapshot
   │ 组装 facts（客观）
   │ 调 ProviderAdapter.analyze(req)
   ▼
UI 渲染 facts / explanations / uncertainty 三段式
```

## 错误处理

| 类型 | 处理 |
|---|---|
| Network | retry 3 + exponential backoff + jitter |
| 429 Rate limited | 解析 X-RateLimit-Reset，等待 |
| 401/403 | UI 显示"需要登录授权"，不自动重试 |
| 5xx | retry 1 次后写入 CollectionTask.errorMessage |
| Malformed | normalize 容错，失败字段记录到 rawData |
| Duplicate | 业务键（bvid / mid + ctime）幂等 |

## 性能

- 同一资源 5 分钟内不重复请求（utils/cache.ts）
- Comment 分页 20 条/页，单次最多 1000 条（截断提示）
- Video 列表分页 30 条/页，最多 200 条/UP 主
- IndexedDB 读写批量（`bulkPut`）

## 安全

- API Key 存 `chrome.storage.local`（fallback `localStorage`）
- content script 不读用户输入框、不抓 Cookie
- 所有 fetch 显式声明 `credentials: 'omit'`
- `.gitignore` 覆盖 .env / token / SESSDATA