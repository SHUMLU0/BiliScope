# BiliScope

> Bilibili 创作者研究 + 内容生态分析 + 个人内容实验工具。

V0.1 = **公开数据可靠采集 + 本地结构化保存 + 基础查询/分析**，为后续 AI 与内容实验闭环打地基。

---

## 项目边界（V0.1 不做什么）

- ❌ 自动剪辑 / 自动出片 / 视频自动发布
- ❌ 跨平台统一发布
- ❌ AI 自动写完整脚本 / 做封面
- ❌ "爆款概率百分比"等伪精确预测
- ❌ 用户系统 / 云数据库 / 付费
- ❌ 破解登录 / 绕过验证码 / 盗取 Cookie

V0.1 只做：**采集 → 存储 → 查询 → 分析 → 提示**，AI 输出强制分 `facts / explanations / uncertainty` 三段。

---

## 主要功能（V0.1）

| Page | 名称 | 核心能力 |
|---|---|---|
| 1 | 账号研究 | UP 主概览、视频列表、历史趋势、客观自动标记 |
| 2 | 全站雷达 | 50w+ UP 主搜索/筛选/排序（阶段化增量） |
| 3 | 评论研究 | 主题/高频词/支持/反对/需求/情绪（强制 anti-词云幻觉） |
| 4 | 我的数据 | 手动输入 UID，查看自有视频 + 多时间点 snapshot |
| 5 | 热点雷达 | 公开热门 / 排行 / 搜索趋势（不含规避监管建议） |
| 6 | 灵感 & 选题 | 一句话保存、状态机：`idea → researching → ready → producing → published → verified / discarded` |

AI 配套：账号分析 / 评论分析 / 视频研究 三类（OpenAI-compatible / DeepSeek / Custom）。

---

## 安装（开发模式）

```bash
pnpm install
pnpm run verify         # 类型 + lint + 单测 + build
pnpm run dev            # 开发模式（Vite watch）
# 在 chrome://extensions/ 打开"开发者模式" → "加载已解压的扩展程序" → 选 dist/
```

---

## 数据来源

- B 站公开 API（`api.bilibili.com`）
- B 站公开网页（被注入 content script 的页面）

**不获取任何 Cookie / Token / SESSDATA / bili_jct**。

详见 [`DATA_POLICY.md`](./DATA_POLICY.md)。

---

## License

MIT（项目主体代码）。第三方参考项见 [`NOTICE`](./NOTICE) 与 [`OPEN_SOURCE_AUDIT.md`](./OPEN_SOURCE_AUDIT.md)。

---

## 注意事项

- 数据来源变化时，采集层可能需要更新。
- 任何 AI 输出仅供参考，不构成操作建议。
- 评论/用户展示已剔除个人敏感字段。

---

## 路线图

- V0.2：账号生命周期、爆款异常检测、评论语义聚类、热点关联
- V0.3：内容实验系统（假设 → 选题 → 制作 → 发布 → 数据 → 复盘 → 验证）