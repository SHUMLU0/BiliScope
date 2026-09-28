/**
 * 纯 JS MD5（RFC 1321）。
 *
 * 为什么需要自己实现：浏览器 Web Crypto（crypto.subtle）不提供 MD5，
 * 而 B 站 WBI 签名规范要求 w_rid = MD5(query + mixin_key)，必须是真正的 MD5，
 * 用 SHA-256 截断是签不对的（服务端校验会直接判风控）。
 *
 * 实现自 RFC 1321 伪代码，无第三方依赖，输入按 UTF-8 编码。
 */

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K_TABLE: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    out.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000) >>> 0);
  }
  return out;
})();

function utf8Bytes(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  // 兜底：jsdom/旧环境可能没有 TextEncoder，按 code point 手工编码 UTF-8
  const out: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      cp = cp - 0x10000;
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? utf8Bytes(input) : input;
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function hex32(x: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

/** 计算 MD5，返回 32 位小写 hex */
export function md5(input: string | Uint8Array): string {
  const msg = toBytes(input);
  const len = msg.length;
  const bitLen = len * 8;

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，再追加 8 字节 bit length（小端）
  const padZeroLen = ((56 - ((len + 1) % 64)) + 64) % 64;
  const total = len + 1 + padZeroLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  // JS 位运算是 32 位，这里拆成低/高两个 32 位写入
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 0x1_0000_0000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < total; off += 64) {
    const m = new Uint32Array(16);
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(off + j * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = (A + f + K_TABLE[i]! + m[g]!) >>> 0;
      const rotated = rotl(tmp, SHIFT[i]!);
      A = D;
      D = C;
      C = B;
      B = (B + rotated) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // MD5 摘要按 A/B/C/D 各自的小端字节序输出
  return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
}

export default md5;
