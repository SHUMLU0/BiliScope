import { db } from '@db/database';
import type { Creator, CreatorSnapshot } from '@models/creator';
import type { Video, VideoSnapshot } from '@models/video';
import type { Comment, CommentAnalysis } from '@models/comment';
import type { HotTopic, Idea, Topic, Experiment } from '@models/idea';
import type { CollectionTask, AIAnalysis } from '@models/task';
import { nowIso } from '@utils/time';

export interface UpsertResult {
  added: number;
  updated: number;
  unchanged: number;
  ids: string[];
}

function ts(): string {
  return nowIso();
}

// ─────────────────────────────────────────────────────────── Creator

export const creatorRepo = {
  async upsertByUid(creator: Creator): Promise<UpsertResult> {
    const existing = await db.creators.where('uid').equals(creator.uid).first();
    if (!existing) {
      await db.creators.add(creator);
      return { added: 1, updated: 0, unchanged: 0, ids: [creator.id] };
    }
    if (existing.updatedAt === creator.updatedAt) {
      return { added: 0, updated: 0, unchanged: 1, ids: [existing.id] };
    }
    await db.creators.update(existing.id, { ...creator, id: existing.id });
    return { added: 0, updated: 1, unchanged: 0, ids: [existing.id] };
  },
  async findByUid(uid: number): Promise<Creator | undefined> {
    return db.creators.where('uid').equals(uid).first();
  },
  async findById(id: string): Promise<Creator | undefined> {
    return db.creators.get(id);
  },
  async list(opts: { limit?: number; offset?: number } = {}): Promise<Creator[]> {
    return db.creators.orderBy('followers').reverse().offset(opts.offset ?? 0).limit(opts.limit ?? 100).toArray();
  },
  async count(): Promise<number> {
    return db.creators.count();
  },
};

export const creatorSnapshotRepo = {
  async add(snapshot: CreatorSnapshot): Promise<string> {
    await db.creatorSnapshots.add(snapshot);
    return snapshot.id;
  },
  async listByCreator(creatorId: string, opts: { since?: string; limit?: number } = {}): Promise<CreatorSnapshot[]> {
    let coll = db.creatorSnapshots.where('creatorId').equals(creatorId);
    if (opts.since) coll = coll.and((s) => s.timestamp >= opts.since!);
    return coll.sortBy('timestamp');
  },
  async latest(creatorId: string): Promise<CreatorSnapshot | undefined> {
    const all = await db.creatorSnapshots.where('creatorId').equals(creatorId).toArray();
    if (!all.length) return undefined;
    return all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
  },
};

// ─────────────────────────────────────────────────────────── Video

/**
 * V0.1.4（P0-数据迁移）：判断一条 Video 的业务字段是否发生变化。
 *
 * 旧实现只比较 `title` + `tags.length`，于是「标题相同、标签数量相同，但
 * pubTime / duration / views / author / description / category / cover 变了」
 * 的情况一律被判为 unchanged —— 历史脏数据（V0.1.0/V0.1.2 写入的
 * pubTime=今天、duration=0、views=null）永远不被修正，Chrome 实机于是
 * 长期显示「0s / 今天」。这里改为比较所有可变的业务字段。
 */
function videoBusinessChanged(a: Video, b: Video): boolean {
  return (
    a.aid !== b.aid ||
    a.creatorId !== b.creatorId ||
    a.title !== b.title ||
    a.description !== b.description ||
    a.cover !== b.cover ||
    a.pubTime !== b.pubTime ||
    a.duration !== b.duration ||
    a.category !== b.category ||
    a.url !== b.url ||
    a.authorName !== b.authorName ||
    a.authorMid !== b.authorMid ||
    a.views !== b.views ||
    JSON.stringify(a.tags) !== JSON.stringify(b.tags)
  );
}

export const videoRepo = {
  async upsertByBvid(video: Video): Promise<UpsertResult> {
    const existing = await db.videos.where('bvid').equals(video.bvid).first();
    if (!existing) {
      await db.videos.add(video);
      return { added: 1, updated: 0, unchanged: 0, ids: [video.id] };
    }
    // V0.1.4（P0-数据迁移）：按业务字段比较，而非只看 title + tags.length。
    if (!videoBusinessChanged(existing, video)) {
      return { added: 0, updated: 0, unchanged: 1, ids: [existing.id] };
    }
    // 更新时保留原始 createdAt（首次采集时间），刷新 updatedAt，主键沿用旧 id。
    // 先展开 video，再用旧记录的真实 createdAt 覆盖，避免把新采集时间写回。
    await db.videos.update(existing.id, {
      ...video,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    return { added: 0, updated: 1, unchanged: 0, ids: [existing.id] };
  },
  async findByBvid(bvid: string): Promise<Video | undefined> {
    return db.videos.where('bvid').equals(bvid).first();
  },
  /**
   * V0.1.3：pubTime 允许为 null，而 IndexedDB 索引不收录 null 值，
   * 继续用 `sortBy('pubTime')` 会把「发布时间未知」的视频整条丢掉（UI 上凭空消失）。
   * 改为按 creatorId 取回后在内存排序：有时间的按时间倒序，未知时间排最后。
   */
  async listByCreator(creatorId: string, opts: { limit?: number; offset?: number } = {}): Promise<Video[]> {
    const arr = await db.videos.where('creatorId').equals(creatorId).toArray();
    arr.sort((a, b) => {
      const x = a.pubTime;
      const y = b.pubTime;
      if (x === y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? 1 : -1;
    });
    return arr.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
  },
  async countByCreator(creatorId: string): Promise<number> {
    return db.videos.where('creatorId').equals(creatorId).count();
  },
};

export const videoSnapshotRepo = {
  async add(snap: VideoSnapshot): Promise<string> {
    await db.videoSnapshots.add(snap);
    return snap.id;
  },
  async listByVideo(videoId: string, opts: { since?: string } = {}): Promise<VideoSnapshot[]> {
    const coll = db.videoSnapshots.where('videoId').equals(videoId);
    const arr = await coll.toArray();
    return arr
      .filter((s) => (opts.since ? s.timestamp >= opts.since : true))
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  },
  async latest(videoId: string): Promise<VideoSnapshot | undefined> {
    const all = await db.videoSnapshots.where('videoId').equals(videoId).toArray();
    if (!all.length) return undefined;
    return all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
  },
  /** V0.2：首个快照（时序基准 = 检查点起算点） */
  async first(videoId: string): Promise<VideoSnapshot | undefined> {
    const all = await db.videoSnapshots.where('videoId').equals(videoId).toArray();
    if (!all.length) return undefined;
    return all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))[0];
  },
};

// ─────────────────────────────────────────────────────────── Comment

/**
 * V0.2.1（P1-9）：判断一条 Comment 的**业务字段**是否变化。
 *  - 静态字段（rpid/ctime/uname/content/replyLevel/关系键）变化 → 视为变化。
 *  - 互动字段（like / replyCount / location / vipStatus / sex / level）变化 → 视为变化，
 *    否则「已存在即 unchanged」会让点赞数、回复数永远停留在首次采集值。
 */
function commentBusinessChanged(a: Comment, b: Comment): boolean {
  return (
    a.rpidStr !== b.rpidStr ||
    a.midStr !== b.midStr ||
    a.rootRpidStr !== b.rootRpidStr ||
    a.parentRpidStr !== b.parentRpidStr ||
    a.dialogStr !== b.dialogStr ||
    a.replyLevel !== b.replyLevel ||
    a.ctime !== b.ctime ||
    a.uname !== b.uname ||
    a.content !== b.content ||
    a.level !== b.level ||
    a.like !== b.like ||
    a.replyCount !== b.replyCount ||
    a.location !== b.location ||
    a.vipStatus !== b.vipStatus ||
    a.sex !== b.sex
  );
}

export const commentRepo = {
  /**
   * V0.2.1（P1-8 / P1-9）：
   *  - 去重键用 **`videoId#rpidStr`**（字符串），不再用 `rpid` 数字——
   *    大 rpid 超出 Number 安全整数范围时会被压成同一个值，导致两条不同评论被判为同一条。
   *  - 已存在的评论：比较**业务字段**（like / replyCount / location / vipStatus / content 等），
   *    有变化 → `updated`（保留主键与 createdAt，刷新 updatedAt）；无变化 → `unchanged`。
   *    旧的「存在即 unchanged」会让互动数据（点赞/回复数）永远不刷新。
   */
  async bulkAdd(comments: Comment[]): Promise<UpsertResult> {
    if (!comments.length) return { added: 0, updated: 0, unchanged: 0, ids: [] };
    const videoIds = new Set<string>();
    for (const c of comments) videoIds.add(c.videoId);
    const allExisting = await db.comments
      .where('videoId')
      .anyOf(Array.from(videoIds))
      .toArray();
    const existMap = new Map<string, Comment>();
    for (const e of allExisting) existMap.set(`${e.videoId}#${e.rpidStr}`, e);

    const toAdd: Comment[] = [];
    let updated = 0;
    let unchanged = 0;
    for (const c of comments) {
      const key = `${c.videoId}#${c.rpidStr}`;
      const existing = existMap.get(key);
      if (!existing) {
        toAdd.push(c);
        continue;
      }
      if (commentBusinessChanged(existing, c)) {
        // 保留主键与首次采集时间，刷新互动字段
        await db.comments.update(existing.id, {
          ...c,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: nowIso(),
        });
        updated++;
      } else {
        unchanged++;
      }
    }
    if (toAdd.length) await db.comments.bulkAdd(toAdd);
    return {
      added: toAdd.length,
      updated,
      unchanged,
      ids: [...toAdd.map((c) => c.id), ...comments.filter((c) => existMap.has(`${c.videoId}#${c.rpidStr}`)).map((c) => existMap.get(`${c.videoId}#${c.rpidStr}`)!.id)],
    };
  },
  async listByVideo(videoId: string, opts: { sinceCtime?: number; limit?: number } = {}): Promise<Comment[]> {
    const coll = db.comments.where('videoId').equals(videoId);
    const arr = await coll.toArray();
    return arr
      .filter((c) => (opts.sinceCtime ? c.ctime >= opts.sinceCtime : true))
      .sort((a, b) => (a.ctime < b.ctime ? -1 : 1))
      .slice(0, opts.limit ?? 500);
  },
  async countByVideo(videoId: string): Promise<number> {
    return db.comments.where('videoId').equals(videoId).count();
  },
};

// ─────────────────────────────────────────────────────────── Comment Analysis

export const commentAnalysisRepo = {
  async add(analysis: CommentAnalysis): Promise<string> {
    await db.commentAnalyses.add(analysis);
    return analysis.id;
  },
  async listByVideo(videoId: string): Promise<CommentAnalysis[]> {
    return db.commentAnalyses.where('videoId').equals(videoId).reverse().sortBy('createdAt');
  },
};

// ─────────────────────────────────────────────────────────── HotTopic

export const hotTopicRepo = {
  /** V0.1.2（P1-9）：id 现在是业务键（source+title 哈希），bulkPut 即为 upsert，不会堆积重复行 */
  async bulkAdd(topics: HotTopic[]): Promise<UpsertResult> {
    if (!topics.length) return { added: 0, updated: 0, unchanged: 0, ids: [] };
    const ids = topics.map((t) => t.id);
    const existingCount = await db.hotTopics.where('id').anyOf(ids).count();
    await db.hotTopics.bulkPut(topics);
    return {
      added: topics.length - existingCount,
      updated: existingCount,
      unchanged: 0,
      ids,
    };
  },
  async listBySource(source: HotTopic['source'], limit = 100): Promise<HotTopic[]> {
    return db.hotTopics.where('source').equals(source).reverse().sortBy('timestamp').then((arr) => arr.slice(0, limit));
  },
};

// ─────────────────────────────────────────────────────────── Idea / Topic / Experiment

export const ideaRepo = {
  async add(idea: Idea): Promise<string> {
    await db.ideas.add(idea);
    return idea.id;
  },
  async list(opts: { status?: Idea['status'] } = {}): Promise<Idea[]> {
    if (opts.status) return db.ideas.where('status').equals(opts.status).reverse().sortBy('createdAt');
    return db.ideas.orderBy('createdAt').reverse().toArray();
  },
  async get(id: string): Promise<Idea | undefined> {
    return db.ideas.get(id);
  },
  /** V0.2 · P1-D：按来源引用反查（热点 → 已生成的灵感） */
  async listBySourceRef(kind: NonNullable<Idea['sourceRef']>['kind'], refId: string): Promise<Idea[]> {
    const all = await db.ideas.toArray();
    return all.filter((i) => i.sourceRef?.kind === kind && i.sourceRef.refId === refId);
  },
  async updateStatus(id: string, status: Idea['status']): Promise<void> {
    await db.ideas.update(id, { status, updatedAt: ts() });
  },
  async remove(id: string): Promise<void> {
    await db.ideas.delete(id);
  },
};

export const topicRepo = {
  async add(topic: Topic): Promise<string> {
    await db.topics.add(topic);
    return topic.id;
  },
  async list(): Promise<Topic[]> {
    return db.topics.toArray();
  },
  async get(id: string): Promise<Topic | undefined> {
    return db.topics.get(id);
  },
  async upsertByName(name: string, patch: Partial<Topic> = {}): Promise<string> {
    const existing = (await db.topics.toArray()).find((t) => t.name === name);
    if (existing) {
      await db.topics.update(existing.id, { ...patch, updatedAt: ts() });
      return existing.id;
    }
    const now = ts();
    const candidate: Topic = {
      id: `tp_${name}`,
      name,
      tags: patch.tags ?? [],
      source: patch.source ?? '',
      competitionLevel: patch.competitionLevel ?? 'unknown',
      notes: patch.notes ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await db.topics.add(candidate);
    return candidate.id;
  },
  /** V3.1.0：选题管理 UI 需要删除能力 */
  async remove(id: string): Promise<void> {
    await db.topics.delete(id);
  },
};

export const experimentRepo = {
  async add(experiment: Experiment): Promise<string> {
    await db.experiments.add(experiment);
    return experiment.id;
  },
  async list(): Promise<Experiment[]> {
    return db.experiments.orderBy('createdAt').reverse().toArray();
  },
  async get(id: string): Promise<Experiment | undefined> {
    return db.experiments.get(id);
  },
  /** V0.2 · P1-D：按想法反查实验（闭环追溯） */
  async listByIdea(ideaId: string): Promise<Experiment[]> {
    const all = await db.experiments.toArray();
    return all.filter((e) => e.ideaId === ideaId);
  },
  async update(id: string, patch: Partial<Experiment>): Promise<void> {
    await db.experiments.update(id, { ...patch, updatedAt: ts() });
  },
};

// ─────────────────────────────────────────────────────────── Task / AI

export const collectionTaskRepo = {
  async add(task: CollectionTask): Promise<string> {
    await db.collectionTasks.add(task);
    return task.id;
  },
  async update(id: string, patch: Partial<CollectionTask>): Promise<void> {
    await db.collectionTasks.update(id, patch);
  },
  async get(id: string): Promise<CollectionTask | undefined> {
    return db.collectionTasks.get(id);
  },
  async listActive(): Promise<CollectionTask[]> {
    return db.collectionTasks.where('status').anyOf(['pending', 'running']).toArray();
  },
  async listRecent(limit = 50): Promise<CollectionTask[]> {
    return db.collectionTasks.orderBy('createdAt').reverse().limit(limit).toArray();
  },
};

export const aiAnalysisRepo = {
  async add(analysis: AIAnalysis): Promise<string> {
    await db.aiAnalyses.add(analysis);
    return analysis.id;
  },
  /** V3.2.0 · AI-META：按 id 精确读取审计行（产品结果经 auditId 关联恢复真实元数据） */
  async get(id: string): Promise<AIAnalysis | undefined> {
    return db.aiAnalyses.get(id);
  },
  async listByTarget(targetId: string, type: AIAnalysis['type']): Promise<AIAnalysis[]> {
    return db.aiAnalyses.where('targetId').equals(targetId).toArray().then((arr) => arr.filter((a) => a.type === type));
  },
};