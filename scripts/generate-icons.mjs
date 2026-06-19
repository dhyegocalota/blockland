// Generates the two PWA icons (192 + 512) as real PNGs: a solid rounded square in
// the platform color on a transparent canvas. Zero deps — raw zlib + PNG chunks.
// Run from the repo root: `node scripts/generate-icons.mjs`.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLATFORM_COLOR = { r: 0x22, g: 0xc5, b: 0x55 };
const CORNER_RADIUS_RATIO = 0.22;
const SIZES = [192, 512];
const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'icons');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function isInsideRoundedSquare({ x, y, size, radius }) {
  const nearLeft = x < radius;
  const nearRight = x >= size - radius;
  const nearTop = y < radius;
  const nearBottom = y >= size - radius;
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true;
  const cornerX = nearLeft ? radius : size - 1 - radius;
  const cornerY = nearTop ? radius : size - 1 - radius;
  return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= radius ** 2;
}

function buildPng(size) {
  const radius = Math.round(size * CORNER_RADIUS_RATIO);
  const raw = Buffer.alloc(size * (1 + size * 4));
  let cursor = 0;
  for (let y = 0; y < size; y++) {
    raw[cursor++] = 0;
    for (let x = 0; x < size; x++) {
      const opaque = isInsideRoundedSquare({ x, y, size, radius });
      raw[cursor++] = opaque ? PLATFORM_COLOR.r : 0;
      raw[cursor++] = opaque ? PLATFORM_COLOR.g : 0;
      raw[cursor++] = opaque ? PLATFORM_COLOR.b : 0;
      raw[cursor++] = opaque ? 0xff : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ICONS_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(ICONS_DIR, `icon-${size}.png`);
  writeFileSync(path, buildPng(size));
  console.log(`[icons] wrote ${path}`);
}
