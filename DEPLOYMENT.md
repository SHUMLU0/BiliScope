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

## 十、版本

当前：**v0.2.2**（**V0.2.2 裸 BV 评论采集依赖闭环修复：新增 `src/services/video-bootstrap.ts` 的 `ensureVideoByBvid()`，评论页可直接输入裸 BV——本地无记录时自动请求 `/x/web-interface/view` 补齐 Creator + Video 依赖，本地已有时 0 次额外请求；新增 `normalizeVideoDetail()`、UI 失败分类、bootstrap 测试 A–F 与真实 Chrome E2E 脚本**；承接 V0.2.1 评论采集真实性修复（`pagination_str` 协议 + 翻页不变量 + 跨页去重，`REAL_API_PASS`） → V0.2.0 研究能力升级 → V0.1.4 数据迁移修复 → V0.1.3 归一化字段映射 → V0.1.2 真实链路修复 → V0.1.1 数据链路修复）

历史版本：v0.2.1 / v0.2.0 / v0.1.4 / v0.1.3 / v0.1.2 / v0.1.1 / v0.1.0。