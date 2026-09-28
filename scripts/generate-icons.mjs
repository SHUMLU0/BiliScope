// scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

function minimalPng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x6e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdrData,
    writeUInt32BE(ihdrCrc),
  ]);

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 4;
      raw[i] = 0x1f;
      raw[i + 1] = 0x29;
      raw[i + 2] = 0x37;
      raw[i + 3] = 0xff;
    }
  }
  const compressed = zlib.deflateSync(raw);

  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), compressed]));
  const idat = Buffer.concat([
    writeUInt32BE(compressed.length),
    Buffer.from('IDAT'),
    compressed,
    writeUInt32BE(idatCrc),
  ]);

  const iendCrc = crc32(Buffer.from('IEND'));
  const iend = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), writeUInt32BE(iendCrc)]);

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = c ^ (buf[i] ?? 0);
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUInt32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

const outDir = join(process.cwd(), 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, minimalPng(size));
  console.log('wrote', file);
}