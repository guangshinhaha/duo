// #42: the app's own icon, drawn from the design tokens — no image
// toolchain, no binary asset checked in unexplained. Run:
//
//   node scripts/make-icon.mjs && npm run tauri -- icon scripts/icon-source.png
//
// The mark is the product's one idea drawn flat: two tiles, one yours
// (--text), one the duo's (--accent), overlapping the way the two of you
// work — the system of record, not a chat bubble. A --bg halo separates
// them so the silhouette holds at menu-bar size.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const BG = [0x0b, 0x0c, 0x0e]; // --bg
const TEXT = [0xe8, 0xea, 0xed]; // --text
const ACCENT = [0x7c, 0x8f, 0xff]; // --accent

// Signed distance to a rounded rectangle: <0 inside, 0 on the edge.
function roundedRectSdf(x, y, cx, cy, half, radius) {
  const dx = Math.abs(x - cx) - (half - radius);
  const dy = Math.abs(y - cy) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Anti-aliased coverage (0..1) of one rounded rect, 4x supersampled. */
function coverage(x, y, cx, cy, half, radius) {
  let inside = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (roundedRectSdf(x + (sx - 1.5) / 4, y + (sy - 1.5) / 4, cx, cy, half, radius) < 0) {
        inside++;
      }
    }
  }
  return inside / 16;
}

function over(dst, src, alpha) {
  return [0, 1, 2].map((i) => Math.round(src[i] * alpha + dst[i] * (1 - alpha)));
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    // macOS-scale squircle: ~22.5% corner radius.
    let color = [0, 0, 0];
    color = over(color, BG, coverage(x, y, SIZE / 2, SIZE / 2, SIZE / 2, 230));
    // The duo's tile, slightly behind and above…
    color = over(color, ACCENT, coverage(x, y, SIZE / 2 - 72, SIZE / 2 - 72, 190, 56));
    // …a --bg halo carving the seam…
    color = over(color, BG, coverage(x, y, SIZE / 2 + 72, SIZE / 2 + 72, 214, 70));
    // …and yours in front.
    color = over(color, TEXT, coverage(x, y, SIZE / 2 + 72, SIZE / 2 + 72, 190, 56));
    row.writeUInt8(color[0], 1 + x * 4);
    row.writeUInt8(color[1], 2 + x * 4);
    row.writeUInt8(color[2], 3 + x * 4);
    row.writeUInt8(255, 4 + x * 4);
  }
  rows.push(row);
}

// Minimal PNG encoder: filter 0 per scanline, one IDAT.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8); // bit depth
ihdr.writeUInt8(6, 9); // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("./icon-source.png", import.meta.url), png);
console.log(`scripts/icon-source.png written (${SIZE}x${SIZE})`);
