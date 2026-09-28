# BiliScope

> Bilibili 创作者研究、评论研究、内容生态分析与 AI 辅助研究工具。

**BiliScope** 是一个 Chrome 扩展（Manifest V3）。它在**本地**保存 B 站公开数据，提供创作者研究、评论研究、内容生态分析与 **可验证的 AI 辅助分析**。

---

## 当前版本

**v3.0.1**

`V3.0.1 = V3.0 可验证 AI 分析系统的稳定性 / 性能 / UI / 文档维护版`。

它不新增研究方向，只修复 V3.0.0 已暴露的真实缺陷：AI 输入样本失控、产品结果持久化错位、请求失败无法诊断、AI 报告位置不合理，并把 GitHub 文档整理到与源码一致。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **账号研究** | UP 主概览、投稿列表、历史趋势快照、客观自动标记 |
| **全站雷达** | UP 主搜索 / 筛选 / 排序（阶段化增量采集） |
| **评论研究** | 直接输入 BV 采集评论，主题 / 高频词 / 支持 / 反对 / 需求 / 情绪的客观统计 + AI 分析报告 |
| **AI 评论分析** | 结构化输出 + Zod 校验 + rpid 引用，报告 9 个分区 |
| **AI 历史审计** | 每次 AI 请求的完整审计记录：Provider / 模型 / finishReason / tokens / 原始 prompt 与响应 |
| **视频数据与快照** | 视频指标随时间的快照（稳定属性归实体，动态指标归快照） |
| **热点 → 灵感 → 实验** | 热点采集 → 一句话灵感 → 状态机式内容实验闭环 |
| **本地数据管理** | 全部数据存于浏览器 IndexedDB，可导出 / 导入 / 一键清空 |
| **任务与诊断** | 采集任务的进度、失败原因与业务码诊断 |

---

## 评论研究

- **直接输入 BV 即可采集评论**：不需要先手动添加 UP 主或视频。
- 本地已有该 `Video` → **不重复请求** `/x/web-interface/view`；本地没有 → 自动 bootstrap（`/view` → 建最小 Creator → 保存 Video）。
- 支持分页采集，遵守「翻页必须前进」的不变量，并对跨页重复做去重。
- 支持一级评论与楼中楼（二级回复）展开，深度可配置。
- **统计事实与 AI 推断严格分离**：统计是客观计算，AI 只做解释。

---

## AI 分析

核心原则：**AI 输出必须是可验证的数据，不是一段字符串。**

- **采集 N 条评论 ≠ AI 必须分析 N 条评论**。
  - 统计基于**全部已采集数据**（采集 200 条 → 统计基数就是 200）。
  - AI 只接收**受控的代表性样本**（默认上限 120 条），由采样策略决定（高赞 / 最新 / 多样性）。
  - UI 会明确显示：`统计基数：200 · AI 分析样本：120`。
- **Structured Output 优先**：能力允许时下发 `json_schema`，否则降级 `json_object`，再降级 prompt 约束 —— 且始终用 Zod 做本地校验。
- **统一领域契约**：`src/ai/schemas.ts` 一处定义，prompt 文本 / JSON Schema / Zod 校验三者同源。
- **引用必须可验证**：`support` / `opposition` 每条论断必须带真实 `rpid`，点击可定位到本地评论；无引用的论断会被显式标注。
- **分层失败诊断**：区分超时 / HTTP 错误 / 网络错误 / 限流 / 输入过大 / Provider 错误 / 空输出 / 截断 / 非法 JSON / schema 不符 / 拒答 / 未配置 Provider，UI 显示真实原因。
- **`AIAnalysis` 是审计记录**（完整 prompt / 原始响应 / token / finishReason），**`CommentAnalysis` 是产品结果**。二者语义分离，UI 只消费产品结果里的结构化业务结果。
- **失败零落库**：只有 `SUCCESS` 才写 `CommentAnalysis`。
- **失败不覆盖历史成功**：再次分析失败时保留最近一次成功结果，并如实说明本次失败原因。
- 支持查看 AI 历史（审计记录）。

---

## AI 流式输出与超时行为

长评论分析（120 条样本 + 大 facts 块）如果只按「总时长」计时，极易在模型正常输出时被误判为**截断**。因此 V3.0.1 起默认走**流式输出**，并把超时模型从「总时长硬切断」改为「空闲监控」。

**流式（默认，推荐）**

- Provider 支持时下发 `stream: true`（OpenAI 兼容）或 `:streamGenerateContent?alt=sse`（Gemini）。
- 逐条读取 SSE `data:` 分片，**增量拼接**正文，并记录 `firstByteAt` / `lastChunkAt` / `chunkCount` / `receivedChars`。
- **JSON.parse 与 Zod 校验只在流接收完成后执行一次**（不是每片校验）。
- 超时策略：
  1. **首个响应等待 30 秒** —— 只提示「模型尚未返回首个响应」，**不终止请求**。
  2. 收到**任意有效分片**后进入输出模式，只监控「距上次新数据」的时间。
  3. **连续 120 秒没有任何新分片** → `AbortController` 终止 → 分类 `REQUEST_TIMEOUT`。
  4. **没有 30 秒 / 60 秒总时长硬切断** —— 「120 条评论跑 90 秒」不会被误判截断。
  5. 不发送额外的「探测 AI 请求」，也不会因为探测失败而杀掉真实请求。
- 进度 UI 全部是**真实数据**：`请求模型… 18s` → `模型已开始输出 · 23s · 已接收 1,204 字符`，**不显示任何假百分比**。

**非流式 fallback（Provider 不支持流式）**

- 默认超时 **120 秒**（可配置 30 / 60 / 90 / 120 秒），UI 显示真实耗时。
- 仅在超时后报 `REQUEST_TIMEOUT`，不会破坏既有 Provider 的可用性。

**能力开关优先级**：`AnalyzeRequest.stream` → `ProviderConfig.supportsStreaming` → 非流式 fallback。

**截断与超时严格区分**：

- `OUTPUT_TRUNCATED` **仅在真实 `finishReason` 表示 token 上限时**（OpenAI `length` / Gemini `MAX_TOKENS`）才出现。
- 网络长时间无响应 → `REQUEST_TIMEOUT`，**绝不**伪装成「输出被截断，请提高输出上限」。

---

## 安装

```bash
pnpm install
pnpm build          # 产出 dist/
```

然后在 Chrome 中加载：

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目下的 `dist/` 目录

开发模式：`pnpm dev`（Vite watch）。质量门禁：`pnpm run verify`（类型 + lint + 单测 + build）。

---

## AI 配置

在扩展的「设置」页配置 Provider：

| Provider | 说明 |
|---|---|
| `openai-compatible` | 任意 OpenAI 兼容端点 |
| `deepseek` | DeepSeek 官方端点 |
| `gemini` | Google Gemini |
| `custom` | 自建 / 代理端点 |

- **API Key 仅保存在本地**（浏览器存储），**不提交 Git、不写入日志、不进入审计包**。
- Provider 的 **endpoint / model 必须互相对应**：程序按 Provider 名读取该 Provider 自己的 `baseUrl / apiKey / model`，不会「请求发到 A 端点却标称是 B」。
- 可配置 `max_tokens`（输出上限）与 **`supportsStreaming`（流式输出开关，默认开启；不确定时可关闭以回退到非流式）**。
- `timeoutMs` 仅用于**非流式链路**（默认 120 秒）；流式链路由「连续 120 秒无新响应」判定超时，与总时长无关。
- 可声明 `supportsJsonSchema`（Structured Outputs 能力）。不确定时留空，程序会自动降级为 JSON mode。

---

## 数据与隐私

- 所有采集数据通过 **IndexedDB 本地存储**，不上传任何服务器。
- 只采集 **B 站公开数据**（公开 API 与公开网页）。
- **不主动获取 Cookie / SESSDATA / bili_jct**，不读取登录态。
- AI 分析会把**用户选择的结构化数据**（统计事实 + 受控评论样本）发送给对应的 AI Provider —— 这是 AI 功能生效的必要条件。
- AI 请求与响应会留下**本地审计记录**，便于复核。
- 详见 [`DATA_POLICY.md`](./DATA_POLICY.md)。

---

## 已知限制

本版本**不声称一切功能已在真实环境端到端打通**。以下限制是真实存在的：

- **B 站可能触发风控**：匿名、无 Cookie 的采集在部分接口 / 环境下会返回 `-352` / `-412` / `-509` 等业务码。此时程序会返回 `ok:false` 并标记 `environmentLimited`，**不会**显示「采集完成 0 条」。
- **深分页与楼中楼可能受环境限制**：极端深度或高频请求下，B 站可能提前结束分页，数据可能不完整。
- **Real Provider E2E 取决于本地配置**：真实 AI 端到端的通过与否取决于使用者本地是否配置了可用的 API Key。仓库内的自动化测试使用 **mock fetch**，因此**本地离线测试通过 ≠ Real API PASS**。
- **Chrome 自动 E2E 在当前环境可能受限**：命令行 `--load-extension` 在部分环境不加载未打包扩展，自动化脚本会如实报告 `CHROME_E2E_ENV_LIMITED`（≠ FAIL），需人工在 `chrome://extensions` 加载 `dist/` 复核。

---

## V3.0 → V3.0.1

| 版本 | 定位 |
|---|---|
| **V3.0** | **可验证 AI 分析系统**：统一领域契约、Structured Output、Zod 校验、分层失败、引用可验证、失败零落库。 |
| **V3.0.1** | **AI 输入性能 / 流式输出与超时诊断 / 持久化结果 / UI 位置 / GitHub 文档整理**。 |

V3.0.1 是一个**维护版**，只修复与打磨，不重写采集层、不更换数据层。

本轮（流式升级）解决的真实问题：

- **长请求被误判截断**：V3.0.0 的适配器用**总时长硬超时**（约 30s）。120 条评论的正常分析在 >35s 后会被 Abort，并被错误归因为 `OUTPUT_TRUNCATED`。
  现在改为**流式 + 空闲监控**：总时长不再构成失败条件，只有「连续 120 秒无新分片」才中止，并正确报 `REQUEST_TIMEOUT`。
- **非流式 Provider 的默认超时偏短**：由 30s / 60s 统一上调为 **120s**，与流式空闲上限一致。

---

## Project Structure

```
BiliScope/
├─ extension/            # MV3 manifest 与静态资源
├─ src/
│  ├─ ai/                # AI 层：schemas / prompts / orchestrator / adapters / failures
│  ├─ collectors/        # 采集层：creator / video / comment / search / hot-topic
│  ├─ normalizers/       # 接口响应 → 领域模型
│  ├─ repositories/      # Dexie 读写（upsert 按业务字段变化）
│  ├─ db/                # Dexie schema 与迁移
│  ├─ models/            # Zod 领域模型（唯一真相）
│  ├─ services/          # 业务编排（评论准备 / 视频 bootstrap / 任务运行器 等）
│  ├─ ui/                # popup / options / content script / 各功能页
│  └─ utils/             # WBI 签名、MD5、HTTP、时间、日志
├─ scripts/              # 验收脚本、E2E 辅助脚本
├─ tests/                # Vitest 单元 / 集成测试
└─ docs/                 # 规格与开发过程文档
```

---

## 文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 系统架构
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本变更记录
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — 构建与发布
- [`DATA_POLICY.md`](./DATA_POLICY.md) — 数据与隐私政策
- [`docs/SPEC.md`](./docs/SPEC.md) — 工程规格
- [`docs/development/PROGRESS.md`](./docs/development/PROGRESS.md) — 开发进度
- [`docs/development/FINAL_AUDIT.md`](./docs/development/FINAL_AUDIT.md) — 最终审计
- [`OPEN_SOURCE_AUDIT.md`](./OPEN_SOURCE_AUDIT.md) — 开源审计
- [`NOTICE`](./NOTICE) — 第三方参考与授权

---

## 注意事项

- 数据来源（B 站接口）可能变化，届时采集层需要更新。
- 任何 AI 输出仅供参考，**不构成任何操作建议**。
- 评论 / 用户展示已剔除个人敏感字段。
- 本项目**不做**「爆款概率百分比」这类伪精确预测。

---

## License

MIT（项目主体代码）。第三方参考项见 [`NOTICE`](./NOTICE) 与 [`OPEN_SOURCE_AUDIT.md`](./OPEN_SOURCE_AUDIT.md)。
