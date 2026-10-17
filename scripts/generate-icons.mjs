/**
 * Generates the PWA icons in public/ with no third-party dependencies.
 *
 * Run with: node scripts/generate-icons.mjs
 *
 * Everything is drawn analytically and rendered with 3x supersampling, then
 * encoded as a PNG (RGBA, 8-bit) using Node's built-in zlib. Regenerate the
 * icons any time the brand colour changes.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** MedScan teal (matches --color-primary-600 in app/globals.css). */
const TEAL = [13, 148, 136];
const WHITE = [255, 255, 255];

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Icon drawing
// ---------------------------------------------------------------------------

/**
 * A teal rounded square with a white pharmacy cross.
 *
 * `rounded: false` produces a full-bleed square (right for maskable icons and
 * apple-touch-icon, both of which are masked by the platform).
 * `badge: true` produces a white cross on transparency (Android status badge).
 */
function drawIcon(size, { rounded = true, badge = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling factor, for smooth edges
  const radius = rounded ? size * 0.22 : 0;

  const centre = size / 2;
  const thickness = size * 0.2;
  const length = size * 0.52;
  const vx0 = centre - thickness / 2;
  const vx1 = centre + thickness / 2;
  const vy0 = centre - length / 2;
  const vy1 = centre + length / 2;
  const hy0 = centre - thickness / 2;
  const hy1 = centre + thickness / 2;
  const hx0 = centre - length / 2;
  const hx1 = centre + length / 2;

  function inSquare(x, y) {
    if (!rounded) return true; // full bleed
    const nearestX = Math.min(Math.max(x, radius), size - radius);
    const nearestY = Math.min(Math.max(y, radius), size - radius);
    const dx = x - nearestX;
    const dy = y - nearestY;
    return dx * dx + dy * dy <= radius * radius;
  }

  function inCross(x, y) {
    const inVertical = x >= vx0 && x < vx1 && y >= vy0 && y < vy1;
    const inHorizontal = x >= hx0 && x < hx1 && y >= hy0 && y < hy1;
    return inVertical || inHorizontal;
  }

  const samples = SS * SS;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let squareHits = 0;
      let crossHits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (inSquare(x, y)) squareHits += 1;
          if (inCross(x, y)) crossHits += 1;
        }
      }

      const squareCoverage = squareHits / samples;
      const crossCoverage = crossHits / samples;

      let r;
      let g;
      let b;
      let alpha;

      if (badge) {
        // White silhouette on transparency.
        r = WHITE[0];
        g = WHITE[1];
        b = WHITE[2];
        alpha = crossCoverage;
      } else {
        // Teal square with the white cross composited on top.
        const mix = squareCoverage > 0 ? crossCoverage / squareCoverage : 0;
        const t = Math.min(1, Math.max(0, mix));
        r = Math.round(TEAL[0] * (1 - t) + WHITE[0] * t);
        g = Math.round(TEAL[1] * (1 - t) + WHITE[1] * t);
        b = Math.round(TEAL[2] * (1 - t) + WHITE[2] * t);
        alpha = squareCoverage;
      }

      const index = (py * size + px) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

// ---------------------------------------------------------------------------
// Write the files
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ["icon-192.png", drawIcon(192, { rounded: true })],
  ["icon-512.png", drawIcon(512, { rounded: true })],
  ["icon-maskable-512.png", drawIcon(512, { rounded: false })],
  ["apple-touch-icon.png", drawIcon(180, { rounded: false })],
  ["badge-72.png", drawIcon(72, { badge: true })],
];

for (const [name, buffer] of outputs) {
  writeFileSync(join(OUT_DIR, name), buffer);
  console.log(`wrote public/${name} (${buffer.length} bytes)`);
}
