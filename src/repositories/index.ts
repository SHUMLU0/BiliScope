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

export const videoRepo = {
  async upsertByBvid(video: Video): Promise<UpsertResult> {
    const existing = await db.videos.where('bvid').equals(video.bvid).first();
    if (!existing) {
      await db.videos.add(video);
      return { added: 1, updated: 0, unchanged: 0, ids: [video.id] };
    }
    if (existing.title === video.title && existing.tags.length === video.tags.length) {
      return { added: 0, updated: 0, unchanged: 1, ids: [existing.id] };
    }
    await db.videos.update(existing.id, { ...video, id: existing.id });
    return { added: 0, updated: 1, unchanged: 0, ids: [existing.id] };
  },
  async findByBvid(bvid: string): Promise<Video | undefined> {
    return db.videos.where('bvid').equals(bvid).first();
  },
  async listByCreator(creatorId: string, opts: { limit?: number; offset?: number } = {}): Promise<Video[]> {
    return db.videos
      .where('creatorId')
      .equals(creatorId)
      .reverse()
      .sortBy('pubTime')
      .then((arr) => arr.reverse().slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50)));
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
};

// ─────────────────────────────────────────────────────────── Comment

export const commentRepo = {
  async bulkAdd(comments: Comment[]): Promise<UpsertResult> {
    if (!comments.length) return { added: 0, updated: 0, unchanged: 0, ids: [] };
    const videoIds = new Set<string>();
    for (const c of comments) videoIds.add(c.videoId);
    const allExisting = await db.comments
      .where('videoId')
      .anyOf(Array.from(videoIds))
      .toArray();
    const existMap = new Map<string, Comment>();
    for (const e of allExisting) existMap.set(`${e.videoId}#${e.rpid}`, e);

    const toAdd: Comment[] = [];
    let unchanged = 0;
    for (const c of comments) {
      const key = `${c.videoId}#${c.rpid}`;
      if (existMap.has(key)) {
        unchanged++;
      } else {
        toAdd.push(c);
      }
    }
    if (toAdd.length) await db.comments.bulkAdd(toAdd);
    return {
      added: toAdd.length,
      updated: 0,
      unchanged,
      ids: toAdd.map((c) => c.id),
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
  async bulkAdd(topics: HotTopic[]): Promise<UpsertResult> {
    if (!topics.length) return { added: 0, updated: 0, unchanged: 0, ids: [] };
    await db.hotTopics.bulkPut(topics);
    return { added: topics.length, updated: 0, unchanged: 0, ids: topics.map((t) => t.id) };
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
};

export const experimentRepo = {
  async add(experiment: Experiment): Promise<string> {
    await db.experiments.add(experiment);
    return experiment.id;
  },
  async list(): Promise<Experiment[]> {
    return db.experiments.orderBy('createdAt').reverse().toArray();
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
  async listByTarget(targetId: string, type: AIAnalysis['type']): Promise<AIAnalysis[]> {
    return db.aiAnalyses.where('targetId').equals(targetId).toArray().then((arr) => arr.filter((a) => a.type === type));
  },
};