// 7-day usage history for the sparklines. Each limit's USED percent is sampled at most once per 10 minutes into one small
// JSON file ([timestamp, percent] pairs under a "provider|limit" key, nothing about accounts). 7 days are kept, at most
// 1,100 samples per limit and 64 series; a file that does not parse is ignored (and replaced by the next save).
import { isFiniteNumber, isInt } from './num';
import { dict } from './json';
import type { Provider } from './model';

export const VERSION = 1;
export const SAMPLE_EVERY = 600;
export const KEEP = 7 * 86400;
export const MAX_SAMPLES = 1100;
export const MAX_SERIES = 64;
export const CLOCK_BACK = 3600; // samples newer than now + this are leftovers of a clock that was set back: dropped
export const GAP = 2 * 3600; // a hole longer than this is drawn as a hole
export const MAX_KEY = 200;

export type Sample = [number, number];
export type Series = Record<string, Sample[]>;

export const keyOf = (provider: string, label: string): string => `${provider}|${label}`.slice(0, MAX_KEY);

function cleanSeries(rows: unknown[], now: number): Sample[] {
  const out: Sample[] = [];
  for (const r of rows) {
    if (Array.isArray(r) && r.length === 2 && isInt(r[0]) && isFiniteNumber(r[1]) && r[1] >= 0 && r[1] <= 100 && r[0] > 0 && r[0] <= now + 60 && now - r[0] <= KEEP) out.push([r[0], r[1]]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(-MAX_SAMPLES);
}

function newest(data: Series): string[] {
  return Object.keys(data).sort((a, b) => data[b][data[b].length - 1][0] - data[a][data[a].length - 1][0]).slice(0, MAX_SERIES);
}

/** The series in `text`, validated entry by entry. Never throws. */
export function load(text: string | null, now: number): Series {
  const out: Series = dict<Sample[]>();
  if (text === null || text.length > 8_000_000) return out;
  let d: unknown;
  try { d = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return out; }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return out;
  const o = d as Record<string, unknown>;
  if (o.version !== VERSION || typeof o.series !== 'object' || o.series === null || Array.isArray(o.series)) return out;
  for (const [k, rows] of Object.entries(o.series as Record<string, unknown>)) {
    if (k.length >= 3 && k.length <= MAX_KEY && Array.isArray(rows)) {
      const c = cleanSeries(rows, now);
      if (c.length) out[k] = c;
    }
  }
  if (Object.keys(out).length > MAX_SERIES) {
    const keep = newest(out);
    for (const k of Object.keys(out)) if (!keep.includes(k)) delete out[k];
  }
  return out;
}

export class History {
  data: Series;
  constructor(text: string | null, private clock: () => number, private persist?: (text: string) => void) {
    this.data = load(text, clock());
  }

  serialize(): string { return JSON.stringify({ version: VERSION, series: this.data }); }

  samples(provider: string, label: string): Array<[number, number]> {
    return (this.data[keyOf(provider, label)] ?? []).map((r) => [r[0], r[1]]);
  }

  /** Adds a sample for every limit of the providers whose refresh worked (and that is due). True when something was added. */
  record(providers: Provider[]): boolean {
    let changed = false;
    try {
      const now = this.clock();
      for (const p of providers) {
        if (!p.installed) continue;
        for (const lim of p.limits) {
          const r = lim.remaining;
          if (!isFiniteNumber(r)) continue;
          const used = Math.max(0, Math.min(100, 100 - r));
          const k = keyOf(p.name, lim.label);
          let rows = this.data[k];
          if (!rows) rows = this.data[k] = [];
          if (rows.length && rows[rows.length - 1][0] > now + CLOCK_BACK) { // the clock was set back: those samples are future junk
            this.data[k] = rows = rows.filter((x) => x[0] <= now + CLOCK_BACK);
            changed = true;
          }
          if (rows.length && (now < rows[rows.length - 1][0] || now - rows[rows.length - 1][0] < SAMPLE_EVERY)) continue;
          rows.push([Math.trunc(now), used]);
          changed = true;
        }
      }
      if (changed) {
        for (const k of Object.keys(this.data)) {
          this.data[k] = this.data[k].filter((r) => now - r[0] <= KEEP).slice(-MAX_SAMPLES);
          if (!this.data[k].length) delete this.data[k];
        }
        if (Object.keys(this.data).length > MAX_SERIES) {
          const keep = newest(this.data);
          for (const k of Object.keys(this.data)) if (!keep.includes(k)) delete this.data[k];
        }
        this.persist?.(this.serialize());
      } else {
        for (const k of Object.keys(this.data)) if (!this.data[k].length) delete this.data[k];
      }
    } catch { /* history problems never reach the refresh */ }
    return changed;
  }
}

// ---- geometry and wording for the sparkline (no drawing here) --------------------------------------

function valid(samples: ReadonlyArray<readonly [number, number]>, now: number): Array<[number, number]> {
  const lo = now - KEEP;
  return samples.filter(([t, u]) => isFiniteNumber(t) && isFiniteNumber(u) && t >= lo && t <= now && u >= 0 && u <= 100).map(([t, u]) => [t, u]);
}

/** The highest valid used-percent in the last 7 days (0 when there is none). */
export function peak(samples: ReadonlyArray<readonly [number, number]>, now: number): number {
  let m = 0;
  for (const [, u] of valid(samples, now)) m = Math.max(m, u);
  return m;
}

export const hasHistory = (samples: ReadonlyArray<readonly [number, number]>, now: number): boolean => valid(samples, now).length >= 2;

/**
 * Polylines for a width x height box (y down, 0% at the bottom, 100% at the top): the last 7 days, oldest at the left. A hole
 * longer than GAP starts a new segment. A lone sample between holes is a one-point segment (a dot). Fewer than two samples in
 * all, or an empty box: nothing.
 */
export function plotSegments(samples: ReadonlyArray<readonly [number, number]>, now: number, width: number, height: number): Array<Array<[number, number]>> {
  const pts = valid(samples, now);
  if (pts.length < 2 || !(isFiniteNumber(width) && isFiniteNumber(height) && width > 0 && height > 0)) return [];
  pts.sort((a, b) => a[0] - b[0]);
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let last: number | null = null;
  for (const [t, u] of pts) {
    if (last !== null && t - last > GAP) { segs.push(cur); cur = []; }
    cur.push([((t - (now - KEEP)) / KEEP) * width, height * (1 - u / 100)]);
    last = t;
  }
  segs.push(cur);
  return segs;
}

/** Spoken summary for screen readers. lines: [label, samples]. */
export function describe(provider: string, lines: Array<[string, ReadonlyArray<readonly [number, number]>]>, now: number): string {
  const bits: string[] = [];
  for (const [label, samples] of lines) {
    const pts = valid(samples, now).sort((a, b) => a[0] - b[0]);
    if (pts.length >= 2) bits.push(`${label} peak ${Math.trunc(Math.max(...pts.map((p) => p[1])))} percent used, now ${Math.trunc(pts[pts.length - 1][1])} percent`);
  }
  return `7-day history, ${provider}: ` + (bits.length ? bits.join('; ') : 'no history yet');
}
