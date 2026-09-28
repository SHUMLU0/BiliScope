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

  it('toCsv escapes commas and quotes', () => {
    const csv = toCsv([{ a: 'x,y', b: '"q"' }]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"""q"""');
  });
});