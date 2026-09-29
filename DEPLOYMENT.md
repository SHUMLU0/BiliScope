# 部署到 Chrome（手动）

> 本文件给最终用户使用 —— 因为沙盒环境无法直接 `gh repo create` / `git push` 到 GitHub。

## 前置

- 已安装 Git 2.x
- 已安装 Node.js 22+ 和 pnpm 10+
- 已登录 GitHub CLI：`gh auth login`（或设置 `GITHUB_TOKEN` 环境变量）

## 一、创建 GitHub 仓库

```bash
gh repo create BiliScope --private --source=. --remote=origin --push
```

若 `gh` 不可用：

```bash
# 1. 在 GitHub 网页手动创建空仓库 BiliScope (Private)
# 2. 不要勾选 README / LICENSE / .gitignore
# 3. 本地：
git remote add origin https://github.com/<your-username>/BiliScope.git
git push -u origin main
```

## 二、安装并加载到 Chrome

```bash
pnpm install
pnpm build
```

打开 `chrome://extensions/`，开启右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/`。

## 三、配置 AI

打开 BiliScope → 设置：

1. 选择 Provider（如 OpenAI-compatible / DeepSeek）
2. 填 Base URL（如 `https://api.deepseek.com/v1`）
3. 填 API Key（仅存 chrome.storage.local）
4. 填 Model（如 `deepseek-chat`）
5. 点击「测试连接」 → 看到 OK 即可
6. 保存

## 四、首次使用

1. 打开任意 B 站 UP 主空间（如 `space.bilibili.com/12345`）
2. 点击 BiliScope 浮窗 → 「分析账号」
3. 切换到 popup 内的「账号研究」 page → 输入 UID → 「采集」

## 五、本地数据库

数据全部存在 IndexedDB（库名 `biliscope`）。重置：

- 进入 BiliScope 设置 → 「清空全部数据」

导出：

- V0.1 UI 未提供导出按钮；可直接调用：

```ts
import { exportAll, toJsonBlob, downloadBlob } from '@/services/export';
const payload = await exportAll();
downloadBlob(toJsonBlob(payload), `biliscope-${new Date().toISOString().slice(0,10)}.json`);
```

## 七、评论页使用（V0.2.2 起可直接输入裸 BV）

打开 `comment.html`，**直接输入任意合法 BV**（例：`BV1D9aA61E6v`）→ 点「采集」：

- 本地**已有**该 Video → 直接采评论，**不发** `/x/web-interface/view` 请求。
- 本地**没有**该 Video → 自动 `bootstrap`：请求 `/x/web-interface/view` → 建立/复用 Creator → 写入 Video → 用其 `aid` 采集评论。

失败信息会分类显示，不再一律「采集失败」：

| 现象 | 含义 |
|---|---|
| `无法获取视频信息：视频信息获取失败：稿件不存在…` | BV 号有误 / 已删除 / 已下架 |
| `无法获取视频信息：视频信息获取失败：响应缺少 data` | B 站返回结构异常（非 0 业务码或空 data） |
| `采集受阻：评论接口风控（环境受限）· …` | 评论接口被风控（`environmentLimited`），可稍后重试 |
| `采集失败：…` | 其他错误（网络 / 超时等） |

## 八、真实 Chrome E2E（可选，验证 bootstrap 链路）

```bash
pnpm build
node scripts/e2e-comment-bootstrap.mjs            # 默认 BV1D9aA61E6v
BV=其他BV node scripts/e2e-comment-bootstrap.mjs
```

脚本会启动真实 Chrome（无头 + 加载 `dist/`），**先清空该 BV 的 Video 与评论**（并断言清理后 Video 计数为 0，证明不是预置数据），再在评论页输入裸 BV 触发采集，最后断言：Video 出现 + 评论入库 + `/x/web-interface/view` 真实被访问。结论分三档：`CHROME_E2E_PASS` / `CHROME_E2E_ENV_LIMITED`（未装 Chrome 或风控）/ `CHROME_E2E_FAIL`。

## 九、CI

`.github/workflows/ci.yml` 在 push 后自动跑：

- install (pnpm)
- typecheck
- lint
- test
- build
- secret-scan
- 上传 dist 产物为 Artifact

若 CI 红：在 GitHub Actions 标签下查看日志，常见原因：

- 502 / 网络问题 → 重跑 workflow
- 测试失败 → 本地 `pnpm test` 复现

## 十、AI 分析（V3.0 起）

AI 分析走统一编排：**Provider → 请求 → 结构化输出 → Zod 校验 → 领域结果 → 落库 → UI**。

### 10.1 输出上限（`max_tokens`）

不再「所有分析一律 1024」。优先级：**请求显式指定 → Provider 配置 → 任务默认值**。

| 任务 | 默认上限 |
|---|---|
| 评论分析（comment） | 4096 |
| 账号 / 视频 / 选题分析 | 2048 |
| 连接测试 | 256 |

若输出因上限被截断（`finishReason=length`），系统**不会**尝试自动修复，而是明确告知：

> `AI 输出被截断（超出输出上限）…（本次上限 4096 tokens，建议提高或减少样本量）`

### 10.2 失败原因分层（不再一律「AI 失败」）

| 状态码 | 含义 | 会自动修复 |
|---|---|---|
| `REQUEST_FAILED` | 网络 / HTTP 非 2xx / 超时 | 否（可重试） |
| `OUTPUT_EMPTY` | HTTP 200 但内容为空 | 否 |
| `OUTPUT_TRUNCATED` | 输出被上限截断 | **否**（提高上限或减少样本） |
| `OUTPUT_INVALID_JSON` | 返回的不是合法 JSON | **是，一次** |
| `OUTPUT_SCHEMA_INVALID` | 合法 JSON 但不符合领域契约 | **是，一次** |
| `OUTPUT_REFUSAL` | 模型拒答（safety / content_filter） | 否 |
| `NO_PROVIDER` | 未配置该 Provider（不借用他人端点） | 否 |

**自动修复上限：总请求 ≤ 2。** 修复 prompt 只允许「把已有结果改写成指定 schema，不添加新的事实」，**不重新分析数据**。

### 10.3 结果落库规则

- `AIAnalysis` = **审计记录**（完整 system/user prompt、原始响应、finishReason、parse 状态、tokens、耗时）。
- `CommentAnalysis` = **产品结果**（UI 直接消费的强类型结构）。
- **只有 `SUCCESS` 才写 `CommentAnalysis`**；任何失败都零落库，绝不留半成品。

### 10.4 可验证性

- `support` / `opposition` 的每一条论断都必须携带真实 `rpid`；UI 中点击 rpid 会**定位并高亮**对应本地评论。
- 没有任何引用的论断会被显式标注 `[无引用]`，并计入「无引用论断」统计。
- 引用到样本中不存在的 rpid 会被审计标记为「不存在的引用」。
- `uncertainty` 强制说明样本量 / 清洗 / 抽样偏差 / 数据完整性；**情绪分布未由结构化输出提供时记 0 并注明「未提供」，不编造。**
- 详见 `ai-history.html`（「AI 历史」）——可按类型筛选、展开查看每次请求的原始 prompt 与响应。

## 十一、版本
当前：**v3.1.0**（**V3.1.0 —— Research Workspace（研究工作台）**。核心：AI 评论数据**隐私化**与工作台 UI：
① **AI 匿名引用**——AI 请求完全不含 rpid/uname/mid/videoId，模型只见 `{ref:"C001",…}`；
`ref→rpid` 映射（citationMap）只随产品结果落本地库，绝不发送 Provider；UI 点击 ref 经映射回溯；
② **AI 时长策略**——流式空闲超时默认 **300s**，可选 60/120/180/300/**不限制**（null 只是不建 idle
timer，AbortController 保留，真实断连/取消仍必须失败）；**AI Test Mode 下 orchestrator 强制归一为
不限制**；③ **研究台 Dashboard**（新首页，只读 IndexedDB 禁联网，KPI 排除探针行）；
④ **Popup 重做**（上下文卡 / 快速操作 / 最近任务 / 零 inline style）；
⑤ **视频库 / 选题库 / Idea→Experiment / 导入导出 UI**；
⑥ **导出版本号修复**（EXPORT-VERSION-001：硬编码 '0.1.0' → `__APP_VERSION__` 单一来源 package.json）。
承接 V3.0.2 AI 开放测试模式 → V3.0.1 稳定性/性能/UI/文档维护版 → V3.0.0 可验证 AI 分析系统 → V0.2.2 裸 BV 评论采集依赖闭环修复 → V0.2.1 评论采集真实性修复（`REAL_API_PASS`） → V0.2.0 研究能力升级 → V0.1.4 数据迁移修复 → V0.1.3 归一化字段映射 → V0.1.2 真实链路修复 → V0.1.1 数据链路修复）

历史版本：v3.0.2 / v3.0.1 / v3.0.0 / v0.2.2 / v0.2.1 / v0.2.0 / v0.1.4 / v0.1.3 / v0.1.2 / v0.1.1 / v0.1.0。