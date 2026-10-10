// WCAG text contrast helpers (relative luminance, ratio) and a "make this colour readable on that background" search.
export type RGB = [number, number, number];

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const q8 = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));

export function rgbOf(hex: string): [number, number, number] | null {
  if (hex.length !== 7 || hex[0] !== '#' || !/^[0-9a-fA-F]{6}$/.test(hex.slice(1))) return null;
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function lighten(hex: string, amount: number): string {
  const c = rgbOf(hex);
  if (!c) return hex;
  const mix = (v: number) => Math.min(255, Math.max(0, Math.round(v + (255 - v) * amount)));
  return '#' + hex2(mix(c[0])) + hex2(mix(c[1])) + hex2(mix(c[2]));
}

export const lin = (v: number): number => {
  const c = Math.min(Math.max(v, 0), 1);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export const Contrast = {
  rgb(hex: string): RGB | null { const c = rgbOf(hex); return c ? [c[0] / 255, c[1] / 255, c[2] / 255] : null; },
  hex(c: RGB): string { return '#' + hex2(q8(c[0])) + hex2(q8(c[1])) + hex2(q8(c[2])); },
  luminance: (c: RGB): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]),
  ratio(a: RGB, b: RGB): number {
    const la = Contrast.luminance(a), lb = Contrast.luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  },
  ratioHex(a: string, b: string): number { return Contrast.ratio(Contrast.rgb(a)!, Contrast.rgb(b)!); },
  mix: (fg: RGB, bg: RGB, a: number): RGB => [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)],
  /** `c` itself when it reaches `minRatio` on `bg`; else moved towards black or white in 2% steps until it does (judged as 8-bit colours). */
  readable(c: RGB, bg: RGB, minRatio = 4.5): RGB {
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;
    const qc = (x: RGB): RGB => [q(x[0]), q(x[1]), q(x[2])];
    if (Contrast.ratio(qc(c), bg) >= minRatio) return qc(c);
    const target: RGB = Contrast.luminance(bg) > 0.18 ? [0, 0, 0] : [1, 1, 1];
    for (let t = 0.02; t <= 1.0001; t += 0.02) {
      const out = qc(Contrast.mix(target, c, Math.min(t, 1)));
      if (Contrast.ratio(out, bg) >= minRatio) return out;
    }
    return target;
  },
  readableHex(hex: string, bgHex: string, minRatio = 4.5): string {
    const c = Contrast.rgb(hex), bg = Contrast.rgb(bgHex);
    return c && bg ? Contrast.hex(Contrast.readable(c, bg, minRatio)) : hex;
  },
};
