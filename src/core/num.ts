// Tolerant number reading for provider responses and files: NaN, Infinity, booleans, null and junk are "no number".

/** A finite number from a number or a plain numeric string ("5", " 12.5 "). Booleans, NaN, Infinity and anything else: null. */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0 || t.length > 40 || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
