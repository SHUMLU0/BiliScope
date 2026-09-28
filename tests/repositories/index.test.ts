import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@db/database';
import { creatorRepo, ideaRepo, videoRepo } from '@repositories/index';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { creatorSchema } from '@models/creator';
import { videoSchema } from '@models/video';
import type { Idea } from '@models/idea';

const now = nowIso();

function makeCreator(uid: number, name = `n${uid}`, at?: string) {
  const ts = at ?? now;
  return creatorSchema.parse({
    id: newId('cr'),
    uid,
    name,
    avatar: undefined,
    sign: '',
    level: 0,
    followers: 0,
    following: 0,
    videoCount: 0,
    spaceUrl: `https://space.bilibili.com/${uid}/`,
    lastCollectedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    source: 'manual',
  });
}

function makeVideo(bvid: string, creatorId: string, at?: string) {
  const ts = at ?? now;
  return videoSchema.parse({
    id: newId('vd'),
    bvid,
    aid: 1,
    creatorId,
    title: 't',
    description: '',
    cover: undefined,
    pubTime: ts,
    duration: 10,
    category: '',
    tags: [],
    url: `https://www.bilibili.com/video/${bvid}`,
    createdAt: ts,
    updatedAt: ts,
    source: 'manual',
  });
}

beforeEach(async () => {
  await db.transaction(
    'rw',
    [db.creators, db.creatorSnapshots, db.videos, db.videoSnapshots, db.ideas],
    async () => {
      await Promise.all([
        db.creators.clear(),
        db.creatorSnapshots.clear(),
        db.videos.clear(),
        db.videoSnapshots.clear(),
        db.ideas.clear(),
      ]);
    },
  );
});
afterEach(async () => {
  // nothing
});

describe('creatorRepo', () => {
  it('upsertByUid add / update / unchanged', async () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-01T00:00:01.000Z';
    const c1 = makeCreator(1, 'n1', t1);
    const r1 = await creatorRepo.upsertByUid(c1);
    expect(r1.added).toBe(1);

    const c2 = makeCreator(1, 'changed', t2);
    const r2 = await creatorRepo.upsertByUid(c2);
    expect(r2.updated).toBe(1);

    const c3 = makeCreator(1, 'changed', t2);
    const r3 = await creatorRepo.upsertByUid(c3);
    expect(r3.unchanged).toBe(1);
  });

  it('findByUid / findById', async () => {
    const c = makeCreator(42);
    await creatorRepo.upsertByUid(c);
    expect((await creatorRepo.findByUid(42))?.name).toBe('n42');
    expect((await creatorRepo.findById(c.id))?.uid).toBe(42);
  });
});

describe('videoRepo', () => {
  it('upsertByBvid add / update', async () => {
    const v1 = makeVideo('BV1xxxxxxxxx', 'c1');
    const r1 = await videoRepo.upsertByBvid(v1);
    expect(r1.added).toBe(1);

    const v2 = videoSchema.parse({ ...v1, title: 'new title' });
    const r2 = await videoRepo.upsertByBvid(v2);
    expect(r2.updated).toBe(1);
  });

  it('listByCreator orders by pubTime desc', async () => {
    const a = makeVideo('BV1aaaaaaaaa', 'c1');
    const b = makeVideo('BV1bbbbbbbbb', 'c1');
    await videoRepo.upsertByBvid(a);
    await videoRepo.upsertByBvid(b);
    const list = await videoRepo.listByCreator('c1');
    expect(list).toHaveLength(2);
  });

  // V0.1.4（P0-数据迁移）：旧实现只比较 title + tags.length，于是「标题/标签没变，
  // 但 pubTime/duration/views 变了」被判 unchanged，历史脏数据（V0.1.0/0.1.2 写入的
  // 0s / 今天）永远不被修正，Chrome 实机长期显示「0s / 今天」。这条回归用例必须覆盖该场景。
  it('P0: 旧记录 title+tags 相同但 pubTime/duration/views 变化时必须更新（纠正历史脏数据）', async () => {
    const bvid = 'BV1xx411c7m5';
    // 模拟早期版本写入的脏数据：duration=0、views 缺失、pubTime=采集时（今天）
    const dirty = videoSchema.parse({
      ...makeVideo('BV1xx411c7m5', 'c9'),
      duration: 0,
      views: undefined,
    });
    const r0 = await videoRepo.upsertByBvid(dirty);
    expect(r0.added).toBe(1);

    // 重新采集拿到正确数据：title/tags 没变，但 pubTime/duration/views 变了
    const fresh = videoSchema.parse({
      ...dirty,
      pubTime: '2026-08-01T12:00:00.000Z',
      duration: 632,
      views: 123456,
    });
    const r1 = await videoRepo.upsertByBvid(fresh);
    expect(r1.updated).toBe(1);
    expect(r1.unchanged).toBe(0);

    const stored = await videoRepo.findByBvid(bvid);
    expect(stored).toBeDefined();
    expect(stored!.pubTime).toBe('2026-08-01T12:00:00.000Z');
    expect(stored!.duration).toBe(632);
    expect(stored!.views).toBe(123456);
    // 首次采集时间必须保留，不能被重新采集时间覆盖
    expect(stored!.createdAt).toBe(dirty.createdAt);
  });

  it('业务字段完全相同（含 title+tags）时返回 unchanged', async () => {
    const v = makeVideo('BV1xx411c7m6', 'c9');
    expect((await videoRepo.upsertByBvid(v)).added).toBe(1);
    const again = videoSchema.parse({ ...v });
    const r = await videoRepo.upsertByBvid(again);
    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
  });
});

describe('ideaRepo', () => {
  it('add / list / updateStatus / remove', async () => {
    const idea: Idea = {
      id: newId('id'),
      title: 'a',
      content: '',
      tags: [],
      source: 'manual',
      status: 'idea',
      notes: '',
      createdAt: now,
      updatedAt: now,
    };
    await ideaRepo.add(idea);
    expect((await ideaRepo.list()).length).toBe(1);
    await ideaRepo.updateStatus(idea.id, 'ready');
    expect((await ideaRepo.list())[0]!.status).toBe('ready');
    await ideaRepo.remove(idea.id);
    expect((await ideaRepo.list()).length).toBe(0);
  });
});