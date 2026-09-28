/**
 * MD5 实现校验（RFC 1321 官方测试向量 + WBI 场景）
 * P0-1：w_rid 必须是真正的 MD5，SHA-256 截断版本在这里会直接失败。
 */

import { describe, expect, it } from 'vitest';
import { md5 } from '@utils/md5';

describe('md5', () => {
  it('RFC 1321 标准向量', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(md5('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'd174ab98d277d9f5a5611c2c9f419d9f',
    );
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });

  it('多字节 UTF-8（中文）与字节数组输入一致', () => {
    expect(md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
    const bytes = new TextEncoder().encode('中文');
    expect(md5(bytes)).toBe(md5('中文'));
  });

  it('输出恒为 32 位小写 hex', () => {
    const out = md5('wbi-sign-test');
    expect(out).toMatch(/^[0-9a-f]{32}$/);
  });

  it('与 Node crypto 的 MD5 逐用例一致（差分校验）', async () => {
    const { createHash } = await import('node:crypto');
    const samples = [
      '',
      'a',
      'abc',
      'mid=2&platform=web&token=&web_location=1550101&wts=1700000000',
      '中文关键词 with emoji 🚀 and symbols !\'()*',
      'x'.repeat(1000),
      'y'.repeat(100_000),
    ];
    for (const s of samples) {
      expect(md5(s)).toBe(createHash('md5').update(s, 'utf8').digest('hex'));
    }
  });

  it('与 SHA-256 截断结果不同（防止退回降级实现）', async () => {
    const input = 'foo=bar&baz=1';
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const shaHex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(md5(input)).not.toBe(shaHex.slice(0, 32));
  });
});
