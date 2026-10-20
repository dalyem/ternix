// Draws the placeholder app icon (build/icon.png, 1024x1024) with no dependencies:
//   node build/generate-icon.mjs
// electron-builder converts the PNG to .icns and .ico when it packages the app, so only
// the PNG is committed. Replace icon.png with real artwork whenever there is some.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SUPERSAMPLE = 3;

/** Distance from point p to segment ab. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedBoxInside(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return Math.hypot(x - cx, y - cy) <= radius;
}

const BG_TOP = [27, 33, 48];
const BG_BOTTOM = [13, 15, 18];
const ACCENT = [138, 180, 255];

function sample(x, y) {
  // Background tile (macOS-style margin) with a vertical gradient.
  if (!roundedBoxInside(x, y, 80, 80, SIZE - 80, SIZE - 80, 190)) return [0, 0, 0, 0];
  const t = (y - 80) / (SIZE - 160);
  let color = BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * t);
  // Prompt chevron ">" and cursor bar "_".
  const stroke = 46;
  const onChevron =
    segmentDistance(x, y, 300, 360, 520, 540) <= stroke ||
    segmentDistance(x, y, 520, 540, 300, 720) <= stroke;
  const onBar = roundedBoxInside(x, y, 560, 690, 760, 690 + stroke * 1.6, stroke * 0.6);
  if (onChevron || onBar) color = ACCENT;
  return [...color, 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      for (let sx = 0; sx < SUPERSAMPLE; sx++) {
        const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SUPERSAMPLE, y + (sy + 0.5) / SUPERSAMPLE);
        r += pr * pa;
        g += pg * pa;
        b += pb * pa;
        a += pa;
      }
    }
    const n = SUPERSAMPLE * SUPERSAMPLE;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
