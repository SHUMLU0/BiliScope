# 数据政策（DATA_POLICY）

## 原则

1. **最小化**：只采集项目功能真正需要的字段。
2. **公开化**：只采集公开接口 / 公开页面，不依赖登录态。
3. **本地化**：所有数据默认存本地 IndexedDB，不上云。
4. **可导出 / 可清除**：用户随时可以 JSON/CSV 导出或一键清空。
5. **不伪造**：不补假数据、不写"暂无快照"以外的占位内容。
6. **可审计**：每次采集记录 `source` + 原始 rawData。

## 采集字段（最小集）

### Creator
- uid, name, avatar, sign, level
- followers, following, videoCount
- spaceUrl, lastCollectedAt

### CreatorSnapshot
- creatorId, timestamp
- followers, following, videoCount, totalViews, totalLikes, totalComments, totalFavorites

### Video
- bvid, aid, creatorId, title, description, cover, pubTime, duration, category, tags, url

### VideoSnapshot
- videoId, timestamp, views, likes, coins, favorites, shares, comments, danmaku

### Comment
- videoId, parentId, memberId, uname, content, like, replyCount, ctime, level
- **不保存**：性别、签名、头像、关注列表、其它个人字段

### CommentAnalysis / AIAnalysis / Idea / Topic / Experiment / HotTopic / CollectionTask
- 按原始指令 §5 定义，但写入前一律 zod 校验

## 不采集

- 用户登录态（Cookie / SESSDATA / bili_jct）
- 任何私密 / 受限 / 需付费的接口
- 个人敏感信息（手机、邮箱、地址）
- 弹幕发送者 ID（仅保留弹幕文本与时间）

## 数据保留

- 全部存本地 IndexedDB，无 TTL。
- 用户可手动清除（Settings → Clear All Data）。

## 数据来源声明

- 接口来源：`api.bilibili.com`（公开）
- 页面来源：`space.bilibili.com` / `www.bilibili.com/video/*`（用户主动打开）

## 风险提示

- Bilibili 接口随时可能变更或下线。本项目不保证数据 100% 可用。
- AI 输出仅为参考，不构成操作建议。

## 变更记录

- 2026-09-28：V0.1 初始版本。