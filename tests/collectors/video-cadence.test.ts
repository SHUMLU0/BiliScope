import { describe, expect, it } from 'vitest';
import { dueSnapshotCheckpoints } from '@collectors/video-collector';

const HOUR = 3_600_000;
const BASE = '2026-01-01T00:00:00.000Z';

describe('dueSnapshotCheckpoints (V0.2 · Group B 时序补采)', () => {
  it('no base snapshot → nothing due', () => {
    expect(dueSnapshotCheckpoints(null, [], Date.parse(BASE) + 100 * HOUR)).toEqual([]);
  });

  it('immediately after first collection → first point already covered, h6 not yet', () => {
    const now = Date.parse(BASE) + 1000;
    // 首采快照就写在 BASE
    expect(dueSnapshotCheckpoints(BASE, [BASE], now)).toEqual([]);
  });

  it('past 6h without a 6h snapshot → h6 due', () => {
    const now = Date.parse(BASE) + 7 * HOUR;
    const due = dueSnapshotCheckpoints(BASE, [BASE], now);
    expect(due).toEqual(['h6']);
  });

  it('past 24h but 6h covered → only h24 due (no duplicate h6)', () => {
    const now = Date.parse(BASE) + 25 * HOUR;
    const sixH = new Date(Date.parse(BASE) + 6 * HOUR).toISOString();
    const due = dueSnapshotCheckpoints(BASE, [BASE, sixH], now);
    expect(due).toEqual(['h24']);
  });

  it('long gap → multiple checkpoints due at once', () => {
    const now = Date.parse(BASE) + 8 * 24 * HOUR;
    const due = dueSnapshotCheckpoints(BASE, [BASE], now);
    expect(due).toEqual(['h6', 'h24', 'h48', 'd7']);
  });

  it('all checkpoints covered → nothing due', () => {
    const now = Date.parse(BASE) + 31 * 24 * HOUR;
    const ts = [0, 6, 24, 48, 7 * 24, 30 * 24].map((h) => new Date(Date.parse(BASE) + h * HOUR).toISOString());
    expect(dueSnapshotCheckpoints(BASE, ts, now)).toEqual([]);
  });
});
