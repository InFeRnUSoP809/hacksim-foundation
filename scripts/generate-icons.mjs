/**
 * Generates the HackSim PWA icon set as PNGs.
 * Dependency-free: renders with plain pixel math and encodes via node:zlib.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const INK = [0x14, 0x16, 0x1c]; // near-black slate
const SIGNAL = [0x30, 0xc4, 0x8c]; // terminal green

const SS = 4; // supersampling factor

/** Signed distance to a rounded rectangle centred at (0,0). */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a thick line segment. */
function sdSegment(px, py, ax, ay, bx, by, half) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - t * vx, wy - t * vy) - half;
}

/**
 * Coverage of the mark at a point, in a -1..1 normalised icon space.
 * The glyph is a terminal prompt: a chevron plus an underscore bar.
 */
function markCoverage(x, y) {
  const stroke = 0.115;

  // Chevron ">"
  const chev = Math.min(
    sdSegment(x, y, -0.34, -0.42, 0.02, 0.0, stroke),
    sdSegment(x, y, 0.02, 0.0, -0.34, 0.42, stroke),
  );

  // Underscore "_"
  const bar = sdSegment(x, y, 0.16, 0.4, 0.5, 0.4, stroke * 0.85);

  return Math.min(chev, bar);
}

/** Renders one icon at `size`px. `bleed` fills the full square (maskable). */
function render(size, { bleed }) {
  const big = size * SS;
  const acc = new Float32Array(big * big * 4);

  // Background geometry
  const half = 0.5;
  const radius = bleed ? half : 0.235;

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const u = (x + 0.5) / big - half;
      const v = (y + 0.5) / big - half;

      const d = sdRoundRect(u, v, half, half, radius);
      const bgA = Math.min(Math.max(0.5 - d * big, 0), 1);

      const m = markCoverage(u, v);
      const fgA = Math.min(Math.max(0.5 - m * big, 0), 1);

      const i = (y * big + x) * 4;
      // Composite: ink background, then signal glyph on top.
      for (let c = 0; c < 3; c++) {
        const base = INK[c] * bgA;
        acc[i + c] = base * (1 - fgA) + SIGNAL[c] * bgA * fgA;
      }
      acc[i + 3] = bgA;
    }
  }

  // Box-downsample the supersampled buffer.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          r += acc[i];
          g += acc[i + 1];
          b += acc[i + 2];
          a += acc[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round((a / n) * 255);
    }
  }

  return out;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline is prefixed with a filter byte (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: "icon-192.png", size: 192, bleed: false },
  { file: "icon-512.png", size: 512, bleed: false },
  { file: "icon-maskable-512.png", size: 512, bleed: true },
  { file: "apple-touch-icon.png", size: 180, bleed: true },
];

mkdirSync(join(ROOT, "public"), { recursive: true });

for (const { file, size, bleed } of targets) {
  const rgba = render(size, { bleed });
  writeFileSync(join(ROOT, "public", file), encodePng(rgba, size));
  console.log(`wrote public/${file} (${size}x${size})`);
}
