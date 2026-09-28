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

## 六、CI

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

## 七、版本

当前：**v0.1.3**（V0.1.1 数据链路修复 + V0.1.2 真实链路最小修复 + V0.1.3 归一化字段映射修复）

下一版本：**v0.2.0** —— 见 `FINAL_AUDIT.md` § 9。