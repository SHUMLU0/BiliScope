/**
 * Dexie database for BiliScope V0.1.
 *
 * 12 tables per SPEC §004:
 *   Creator / CreatorSnapshot / Video / VideoSnapshot /
 *   Comment / CommentAnalysis / HotTopic / Idea /
 *   Topic / Experiment / CollectionTask / AIAnalysis
 *
 * 主键：string id（自生成，源类型）
 * 索引：业务键（uid / bvid / videoId / creatorId）+ 时间戳
 */

import Dexie, { type Table } from 'dexie';
import type {
  AIAnalysis,
  CollectionTask,
  Comment,
  CommentAnalysis,
  Creator,
  CreatorSnapshot,
  Experiment,
  HotTopic,
  Idea,
  Topic,
  Video,
  VideoSnapshot,
} from '@models/index';

export class BiliScopeDB extends Dexie {
  creators!: Table<Creator, string>;
  creatorSnapshots!: Table<CreatorSnapshot, string>;
  videos!: Table<Video, string>;
  videoSnapshots!: Table<VideoSnapshot, string>;
  comments!: Table<Comment, string>;
  commentAnalyses!: Table<CommentAnalysis, string>;
  hotTopics!: Table<HotTopic, string>;
  ideas!: Table<Idea, string>;
  topics!: Table<Topic, string>;
  experiments!: Table<Experiment, string>;
  collectionTasks!: Table<CollectionTask, string>;
  aiAnalyses!: Table<AIAnalysis, string>;

  constructor(name = 'biliscope') {
    super(name);
    this.version(1).stores({
      creators: 'id, &uid, name, followers, lastCollectedAt',
      creatorSnapshots: 'id, creatorId, timestamp, [creatorId+timestamp]',
      videos: 'id, &bvid, creatorId, pubTime, [creatorId+pubTime]',
      videoSnapshots: 'id, videoId, timestamp, [videoId+timestamp]',
      comments: 'id, videoId, memberId, ctime, [videoId+ctime]',
      commentAnalyses: 'id, videoId, createdAt',
      hotTopics: 'id, source, rank, timestamp',
      ideas: 'id, status, createdAt, [status+createdAt]',
      topics: 'id, name',
      experiments: 'id, status, createdAt',
      collectionTasks: 'id, type, status, targetId, createdAt',
      aiAnalyses: 'id, type, targetId, provider, createdAt',
    });
  }
}

export const db = new BiliScopeDB();

/** 清空全部数据（危险，仅供测试 / 用户主动操作） */
export async function clearAll(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.creators,
      db.creatorSnapshots,
      db.videos,
      db.videoSnapshots,
      db.comments,
      db.commentAnalyses,
      db.hotTopics,
      db.ideas,
      db.topics,
      db.experiments,
      db.collectionTasks,
      db.aiAnalyses,
    ],
    async () => {
      await Promise.all([
        db.creators.clear(),
        db.creatorSnapshots.clear(),
        db.videos.clear(),
        db.videoSnapshots.clear(),
        db.comments.clear(),
        db.commentAnalyses.clear(),
        db.hotTopics.clear(),
        db.ideas.clear(),
        db.topics.clear(),
        db.experiments.clear(),
        db.collectionTasks.clear(),
        db.aiAnalyses.clear(),
      ]);
    },
  );
}