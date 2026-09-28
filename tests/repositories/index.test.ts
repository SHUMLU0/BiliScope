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