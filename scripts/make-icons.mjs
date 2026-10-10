// Draws the app icon (1024 px) and the monochrome tray icons with plain code, so the repo has no binary design files to trust.
// Usage: node scripts/make-icons.mjs   then   npx tauri icon src-tauri/icons/source.png
import zlib from 'node:zlib';
import fs from 'node:fs';

function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** shape(x, y) in 0..1 units -> coverage 0..1 (4x4 supersampling) */
function render(size, shape) {
  const buf = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const px = shape((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size);
      if (px) { r += px[0] * px[3]; g += px[1] * px[3]; b += px[2] * px[3]; a += px[3]; }
    }
    const o = (y * size + x) * 4, n = N * N;
    if (a > 0) { buf[o] = Math.round(r / a); buf[o + 1] = Math.round(g / a); buf[o + 2] = Math.round(b / a); buf[o + 3] = Math.round((a / n) * 255); }
  }
  return buf;
}
const inRound = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
const distSeg = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};

// App icon: blue rounded square, white card with a check and two lines
const app = render(1024, (x, y) => {
  if (!inRound(x, y, 0.04, 0.04, 0.96, 0.96, 0.2)) return null;
  const t = (x + y) / 2;
  const base = [47 + 40 * t, 123 - 30 * t, 245 - 30 * t, 1];
  if (distSeg(x, y, 0.27, 0.5, 0.42, 0.65) < 0.05 || distSeg(x, y, 0.42, 0.65, 0.72, 0.33) < 0.05) return [255, 255, 255, 1];
  if (distSeg(x, y, 0.28, 0.8, 0.72, 0.8) < 0.03) return [255, 255, 255, 0.85];
  return base;
});
fs.writeFileSync('src-tauri/icons/source.png', png(1024, 1024, app));

// Tray icon: black on transparent (macOS template image; Windows/Linux get the same shape in white)
for (const [name, rgb] of [['tray-template', [0, 0, 0]], ['tray-light', [255, 255, 255]]]) {
  const t = render(64, (x, y) => {
    const ring = inRound(x, y, 0.08, 0.08, 0.92, 0.92, 0.22) && !inRound(x, y, 0.19, 0.19, 0.81, 0.81, 0.12);
    const check = distSeg(x, y, 0.3, 0.52, 0.44, 0.66) < 0.07 || distSeg(x, y, 0.44, 0.66, 0.72, 0.34) < 0.07;
    return ring || check ? [...rgb, 1] : null;
  });
  fs.writeFileSync(`src-tauri/icons/${name}.png`, png(64, 64, t));
}
console.log('icons written');
