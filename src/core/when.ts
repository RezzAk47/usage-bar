// Time maths on absolute epoch seconds. Local clock times are only used for display; every difference is computed on
// epoch seconds, so DST changes and time zones cannot make a countdown wrong.
import { asNumber, isFiniteNumber } from './num';

const MAX_EPOCH_S = 1e11; // year 5138: anything bigger as seconds is milliseconds (or garbage)

/**
 * A reset / timestamp as epoch SECONDS (may be fractional), or null.
 * Accepts: epoch seconds, epoch milliseconds, the same as numeric strings, and ISO-8601 strings with any number of
 * fraction digits and a Z or numeric offset (no offset = UTC). Booleans, NaN, objects, arrays, huge numbers: null.
 */
export function parseWhen(v: unknown): number | null {
  if (typeof v === 'boolean' || v === null || v === undefined) return null;
  let n = asNumber(v);
  if (n !== null) {
    if (n <= 0) return null;
    if (n >= MAX_EPOCH_S) n /= 1000;
    return n > 0 && n < MAX_EPOCH_S ? n : null;
  }
  if (typeof v !== 'string' || v.length > 64) return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?\s*$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const frac = m[7] ? Number('0.' + m[7].slice(0, 9)) : 0;
  const base = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
  const check = new Date(base);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // 31 Feb
  let offset = 0;
  const z = m[8];
  if (z && z.toLowerCase() !== 'z') {
    const sign = z[0] === '-' ? -1 : 1;
    const digits = z.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2)), om = Number(digits.slice(2) || '0');
    if (oh > 23 || om > 59) return null;
    offset = sign * (oh * 3600 + om * 60);
  }
  const out = base / 1000 - offset + frac;
  return out > 0 && out < MAX_EPOCH_S ? out : null;
}

// ---- time zones (Intl; no library) ---------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(key, f);
  }
  return f;
}

export interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** Wall-clock parts of an epoch-seconds instant in `tz` (undefined = the machine's zone). */
export function partsOf(epoch: number, tz?: string): Parts {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(Math.floor(epoch) * 1000))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

const offsetAt = (epoch: number, tz?: string): number => {
  const p = partsOf(epoch, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000 - Math.floor(epoch);
};

/**
 * Epoch seconds of a wall-clock time in `tz`. The offsets in force a day before and a day after are tried: the ones that map back to
 * the same wall-clock time are real answers (an hour that happens twice gives two; the earlier is returned). A time that does not
 * exist (DST gap) lands on the instant after the gap. Never loops, so it cannot oscillate at a transition.
 */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number | null {
  const all = zonedAll(y, mo, d, h, mi, tz);
  return all.length ? all[0] : null;
}

/** Every instant that shows this wall-clock time in `tz`, earliest first: two in the repeated hour of a fall-back night, one
 *  normally, and for a time in a spring-forward gap the single instant after the gap. */
function zonedAll(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number[] {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0) / 1000;
  if (!Number.isFinite(naive)) return [];
  const offsets = [...new Set([offsetAt(naive - 86400, tz), offsetAt(naive, tz), offsetAt(naive + 86400, tz)])];
  const cands = offsets.map((o) => naive - o);
  const real = cands.filter((c) => offsetAt(c, tz) === naive - c).sort((a, b) => a - b);
  return real.length ? real : [Math.max(...cands)];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Reset TEXT ("resets 17:19", "resets 09:00 on 9 Oct", local time) to epoch seconds. A time without a date is the NEXT occurrence
 * after `now` in `tz` (today if it is still ahead, else tomorrow; in the repeated hour of a fall-back night the second
 * occurrence counts too). With a date, the year nearest to `now` wins.
 */
export function parseResetText(text: unknown, now: number, tz?: string): number | null {
  if (typeof text !== 'string' || text.length > 120 || !isFiniteNumber(now)) return null;
  const m = /^\s*resets\s+(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9}))?\s*$/i.exec(text);
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const today = partsOf(now, tz);
  const cands: number[] = [];
  if (m[3]) {
    const mon = MONTHS.indexOf(m[4].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    const day = Number(m[3]);
    for (const year of [today.y - 1, today.y, today.y + 1]) {
      if (new Date(Date.UTC(year, mon, day)).getUTCMonth() !== mon) continue; // 31 Feb
      const e = zonedToEpoch(year, mon + 1, day, hour, minute, tz);
      if (e !== null) cands.push(e);
    }
  } else {
    for (const delta of [0, 1, 2]) {
      const dt = new Date(Date.UTC(today.y, today.mo - 1, today.d + delta));
      cands.push(...zonedAll(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), hour, minute, tz));
    }
    const next = cands.filter((c) => c > now);
    return next.length ? Math.min(...next) : null;
  }
  if (cands.length === 0) return null;
  return cands.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
}

const two = (n: number) => String(n).padStart(2, '0');

/** "resets 17:19" for a reset today, "resets 09:00 on 9 Oct" otherwise (local time in `tz`). '' when unknown. */
export function resetText(resetAt: number | null | undefined, now: number, tz?: string): string {
  if (!isFiniteNumber(resetAt) || !isFiniteNumber(now) || resetAt <= 0) return '';
  const r = partsOf(resetAt, tz), n = partsOf(now, tz);
  const clock = `${two(r.h)}:${two(r.mi)}`;
  const sameDay = r.y === n.y && r.mo === n.mo && r.d === n.d;
  return sameDay ? `resets ${clock}` : `resets ${clock} on ${r.d} ${MONTH_NAMES[r.mo - 1]}`;
}

/**
 * 'in 2 h 14 min', 'in 3 d 4 h', 'in 45 min', 'resetting' once the time has come; '' for bad input.
 * Minutes round up, so it never claims less time than is left (and never shows 0 min).
 */
export function countdown(resetAt: unknown, now: unknown): string {
  if (!isFiniteNumber(resetAt) || !isFiniteNumber(now)) return '';
  const left = resetAt - now;
  if (left <= 0) return 'resetting';
  const minutes = Math.max(1, Math.ceil(left / 60));
  const days = Math.floor(minutes / 1440), rest = minutes % 1440;
  const hours = Math.floor(rest / 60), mins = rest % 60;
  const parts = days ? [`${days} d`, ...(hours ? [`${hours} h`] : [])] : hours ? [`${hours} h`, ...(mins ? [`${mins} min`] : [])] : [`${mins} min`];
  return 'in ' + parts.join(' ');
}

/** The sub-line: 'Resets 17:19 · in 2 h 14 min' (the text part capitalised for display). */
export function resetLine(resets: string, resetAt: number | null | undefined, now: number): string {
  if (!resets) return '';
  const cd = countdown(resetAt, now);
  const head = resets[0].toUpperCase() + resets.slice(1);
  return cd ? `${head} · ${cd}` : head;
}
