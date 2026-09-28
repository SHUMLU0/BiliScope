import { describe, expect, it } from 'vitest';
import { newId, newTempId } from '@utils/id';

describe('id', () => {
  it('generates unique ids', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(newId());
    expect(set.size).toBe(1000);
  });

  it('respects prefix', () => {
    const id = newId('cr');
    expect(id.startsWith('cr_')).toBe(true);
  });

  it('newTempId always has prefix', () => {
    expect(newTempId().startsWith('tmp_')).toBe(true);
  });

  it('id length is consistent', () => {
    const id = newId();
    // ts(4) + nanoid(12) = 16 chars
    expect(id.length).toBeGreaterThanOrEqual(15);
    expect(id.length).toBeLessThanOrEqual(18);
  });
});