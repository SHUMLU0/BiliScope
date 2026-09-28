import { describe, expect, it } from 'vitest';
import { exportAll, toCsv } from '@services/export';
import { previewImport, applyImport } from '@services/import';
import { db } from '@db/database';
import { newId } from '@utils/id';
import { nowIso } from '@utils/time';
import { creatorSchema } from '@models/creator';

describe('export / import', () => {
  it('round-trip JSON preserves creator', async () => {
    await db.creators.clear();
    const c = creatorSchema.parse({
      id: newId('cr'),
      uid: 999,
      name: 'rt',
      avatar: undefined,
      sign: '',
      level: 0,
      followers: 1,
      following: 0,
      videoCount: 0,
      spaceUrl: 'https://space.bilibili.com/999/',
      lastCollectedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: 'manual',
    });
    await db.creators.add(c);

    const p = await exportAll();
    const json = JSON.stringify(p);
    const preview = await previewImport(json);
    expect(preview.ok).toBe(true);
    expect(preview.counts.creators).toBe(1);

    // simulate replace
    await db.creators.clear();
    if (preview.payload) await applyImport(preview.payload, 'replace');
    const back = await db.creators.toArray();
    expect(back.length).toBe(1);
    expect(back[0]!.uid).toBe(999);
  });

  it('invalid json fails preview', async () => {
    const r = await previewImport('{ not json');
    expect(r.ok).toBe(false);
  });

  // V0.1.2（P1-5）：导入必须真的过 Zod —— 非法行跳过 + 计数，不能 bulkPut 脏数据
  it('Zod 校验：非法行被跳过并如实上报', async () => {
    await db.creators.clear();
    const good = {
      id: newId('cr'),
      uid: 1001,
      name: 'ok',
      avatar: undefined,
      sign: '',
      level: 0,
      followers: 1,
      following: 0,
      videoCount: 0,
      spaceUrl: 'https://space.bilibili.com/1001/',
      lastCollectedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: 'manual',
    };
    const payload = {
      exportedAt: nowIso(),
      version: '0.1.0',
      // uid / spaceUrl / source 均非法
      data: { creators: [good, { id: 'x', uid: -5, name: 'bad', spaceUrl: 'nope', source: 'xxx' }] },
    };

    const preview = await previewImport(JSON.stringify(payload));
    expect(preview.ok).toBe(true);
    expect(preview.counts.creators).toBe(1);
    expect(preview.invalid.creators).toBe(1);
    expect(preview.errors.length).toBeGreaterThan(0);

    // merge 模式：合法行写入，非法行跳过
    const res = await applyImport(payload, 'merge');
    expect(res.imported.creators).toBe(1);
    expect(res.skipped.creators).toBe(1);
    const rows = await db.creators.toArray();
    expect(rows.length).toBe(1);
    expect(rows[0]!.uid).toBe(1001);

    // V0.1.3（P1-原子性）：replace 模式只要有一条非法就整体拒绝，
    // 绝不能"先清空再发现数据坏了"—— 这里必须验证旧数据仍在。
    const before = await db.creators.count();
    expect(before).toBe(1);
    const rejected = await applyImport(payload, 'replace');
    expect(rejected.imported.creators).toBeUndefined();
    expect(rejected.errors.join('\n')).toMatch(/整体拒绝/);
    expect(await db.creators.count()).toBe(1);
  });

  it('replace 模式：全部合法 → 单事务 clear + bulkPut', async () => {
    await db.creators.clear();
    const mk = (uid: number) => ({
      id: newId('cr'),
      uid,
      name: `u${uid}`,
      sign: '',
      spaceUrl: `https://space.bilibili.com/${uid}/`,
      lastCollectedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: 'manual' as const,
      // V0.1.3：计数器可空 —— 缺失/风控时必须为 null，绝不能写 0
      level: null,
      followers: null,
      following: null,
      videoCount: null,
    });
    await db.creators.add(mk(7001));
    const payload = {
      exportedAt: nowIso(),
      version: '0.1.2',
      data: { creators: [mk(8001), mk(8002)] },
    };
    const res = await applyImport(payload, 'replace');
    expect(res.imported.creators).toBe(2);
    const after = await db.creators.toArray();
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.uid).sort()).toEqual([8001, 8002]);
  });

  it('applyImport 绕过 preview 也照样校验（不信任传入 payload）', async () => {
    await db.creators.clear();
    const res = await applyImport(
      {
        exportedAt: nowIso(),
        version: '0.1.0',
        data: { creators: [{ id: 'no-uid', name: 'bad' }] },
      },
      'merge',
    );
    expect(res.imported.creators).toBeUndefined();
    expect(res.skipped.creators).toBe(1);
    expect(await db.creators.count()).toBe(0);
  });

  it('toCsv escapes commas and quotes', () => {
    const csv = toCsv([{ a: 'x,y', b: '"q"' }]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"""q"""');
  });
});