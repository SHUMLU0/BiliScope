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

    const res = await applyImport(payload, 'replace');
    expect(res.imported.creators).toBe(1);
    expect(res.skipped.creators).toBe(1);
    const rows = await db.creators.toArray();
    expect(rows.length).toBe(1);
    expect(rows[0]!.uid).toBe(1001);
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