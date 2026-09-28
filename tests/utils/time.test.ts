import { describe, expect, it } from 'vitest';
import { formatDuration, formatInt, nowIso, secondsToIso } from '@utils/time';

describe('time', () => {
  it('nowIso returns valid ISO', () => {
    const t = nowIso();
    expect(Number.isNaN(Date.parse(t))).toBe(false);
  });

  it('secondsToIso converts correctly', () => {
    const iso = secondsToIso(0);
    expect(new Date(iso).getUTCFullYear()).toBe(1970);
  });

  it('formatDuration: 7321 sec', () => {
    expect(formatDuration(7321)).toBe('02h 02m 01s');
  });

  it('formatDuration: 0', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formatDuration: negative -> 0s', () => {
    expect(formatDuration(-10)).toBe('0s');
  });

  it('formatDuration: days', () => {
    expect(formatDuration(86400 * 3 + 3600)).toBe('3d 01h 00m 00s');
  });

  it('formatDuration: minutes only', () => {
    expect(formatDuration(125)).toBe('02m 05s');
  });

  it('formatInt: thousands sep', () => {
    expect(formatInt(1234567)).toMatch(/1[,.]234[,.]567/);
  });

  it('formatInt: null/undefined', () => {
    expect(formatInt(null)).toBe('–');
    expect(formatInt(undefined)).toBe('–');
  });

  it('formatInt: NaN', () => {
    expect(formatInt(Number.NaN)).toBe('–');
  });
});