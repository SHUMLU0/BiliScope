/**
 * B 站业务码判定（P0-2 的基础设施）
 * 核心事实：风控是 HTTP 200 + code != 0，不会抛异常。
 */

import { describe, expect, it } from 'vitest';
import { BILI_BLOCKED_CODES, BILI_REFERRER, biliCode, hasBiliData, isBiliBlocked } from '@utils/bili';

describe('biliCode', () => {
  it('取出业务码', () => {
    expect(biliCode({ code: 0 })).toBe(0);
    expect(biliCode({ code: -352 })).toBe(-352);
    expect(biliCode({})).toBeNull();
    expect(biliCode(null)).toBeNull();
    expect(biliCode('x')).toBeNull();
  });
});

describe('isBiliBlocked', () => {
  it('code=0 视为可用', () => {
    expect(isBiliBlocked({ code: 0, data: {} })).toBe(false);
  });

  it('风控码视为被拦', () => {
    for (const c of [-352, -403, -412, -799]) {
      expect(isBiliBlocked({ code: c })).toBe(true);
    }
  });

  it('非对象响应视为被拦', () => {
    expect(isBiliBlocked(null)).toBe(true);
    expect(isBiliBlocked('not json')).toBe(true);
  });

  it('未知的非 0 码不算「被拦」（不是风控，是别的业务语义）', () => {
    expect(BILI_BLOCKED_CODES.has(-400)).toBe(false);
    expect(isBiliBlocked({ code: -400 })).toBe(false);
  });
});

describe('hasBiliData', () => {
  it('区分 data 为 null 的情况', () => {
    expect(hasBiliData({ code: 0, data: { mid: 1 } })).toBe(true);
    expect(hasBiliData({ code: 0, data: null })).toBe(false);
    expect(hasBiliData({ code: 0 })).toBe(false);
  });
});

describe('BILI_REFERRER', () => {
  it('生成 bilibili 域的 referrer', () => {
    expect(BILI_REFERRER.www).toBe('https://www.bilibili.com/');
    expect(BILI_REFERRER.search).toBe('https://search.bilibili.com/');
    expect(BILI_REFERRER.space(12345)).toBe('https://space.bilibili.com/12345/');
    expect(BILI_REFERRER.video('BV1GJ411x7h7')).toBe('https://www.bilibili.com/video/BV1GJ411x7h7');
  });
});
