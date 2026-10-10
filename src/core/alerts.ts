// Usage alerts: one notification when a limit's USED percent crosses a threshold. The same window never alerts twice:
// the key is provider + limit + reset time. Fired keys are kept in a small JSON file (strict load) so a restart does not
// repeat them. A key re-arms when the window resets (a new reset time) or usage falls 5 points below the threshold.
// Only providers whose refresh worked are checked, so stale numbers never alert. A window counts as alerted only after
// the delivery succeeded; a failed one is retried on later checks, at most MAX_RETRIES times (the count is saved).
import { isInt } from './num';
import { countdown } from './when';
import { DeliveryQueue } from './queue';
import type { Limit, Provider } from './model';

export const VERSION = 1;
export const KEEP_SECONDS = 8 * 86400;
export const MAX_ENTRIES = 500;
export const SAME_WINDOW = 600; // reset times this close (s) are the same window: the API rounds them
export const REARM_POINTS = 5;
export const MAX_RETRIES = 3;
export const MAX_FUTURE = 400 * 86400;
export const BURST_OVER = 3; // more than this many due alerts in one check become one summary
const MAX_TEXT = 100;

export interface Alert { provider: string; label: string; used: number; level: number; resetAt: number | null }
export interface Entry { p: string; l: string; w: number; v: number; t: number }
export interface Notice { title: string; body: string }
export interface AlertSettings { alertsOn: boolean; alertLow: number; alertHigh: number }

const isEntry = (e: unknown, now: number): e is Entry => {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length === 5 && ['p', 'l', 'w', 'v', 't'].every((k) => keys.includes(k)) &&
    typeof o.p === 'string' && typeof o.l === 'string' && o.p.length > 0 && o.p.length <= MAX_TEXT && o.l.length > 0 && o.l.length <= MAX_TEXT &&
    isInt(o.w) && isInt(o.v) && isInt(o.t) && o.w >= 0 && o.w < 1e12 && o.v > 0 && o.v <= 100 && o.t > 0 && o.t <= now + MAX_FUTURE;
};

/** Entries within KEEP_SECONDS of the newest moment we know: the clock or the newest entry, whichever is later (clock-set-back safe). */
function fresh(entries: Entry[], now: number): Entry[] {
  let ref = now;
  for (const e of entries) ref = Math.max(ref, e.t);
  return entries.filter((e) => ref - e.t <= KEEP_SECONDS);
}

function readFile(text: string | null): Record<string, unknown> | null {
  if (text === null || text.length > 1_000_000) return null;
  try {
    const d = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (typeof d !== 'object' || d === null || Array.isArray(d) || (d as Record<string, unknown>).version !== VERSION) return null;
    return d as Record<string, unknown>;
  } catch { return null; }
}

export function loadFired(text: string | null, now: number): Entry[] {
  const d = readFile(text);
  if (!d || !Array.isArray(d.fired)) return [];
  return fresh(d.fired.filter((e): e is Entry => isEntry(e, now)).map((e) => ({ p: e.p, l: e.l, w: e.w, v: e.v, t: e.t })), now).slice(-MAX_ENTRIES);
}

export function loadTries(text: string | null, now: number): Map<string, [number, number]> {
  const d = readFile(text);
  const out = new Map<string, [number, number]>();
  if (!d || !Array.isArray(d.tries)) return out;
  for (const e of d.tries) {
    if (typeof e === 'object' && e !== null && !Array.isArray(e)) {
      const o = e as Record<string, unknown>;
      if (Object.keys(o).length === 3 && typeof o.k === 'string' && o.k.length > 0 && o.k.length <= 300 && isInt(o.n) && isInt(o.t) &&
        o.n > 0 && o.n <= MAX_RETRIES + 1 && o.t > 0 && o.t <= now + MAX_FUTURE && now - o.t <= KEEP_SECONDS) out.set(o.k, [o.n, o.t]);
    }
  }
  return new Map([...out].slice(-MAX_ENTRIES));
}

const usedOf = (l: Limit): number | null => (typeof l.remaining === 'number' && Number.isFinite(l.remaining) ? Math.max(0, Math.min(100, 100 - l.remaining)) : null);
const windowOf = (l: Limit): number => (typeof l.resetAt === 'number' && Number.isFinite(l.resetAt) && l.resetAt > 0 ? Math.trunc(l.resetAt) : 0);
/** Same window: reset times close together. An unknown reset (0) on either side matches (the API sometimes drops the time). */
const same = (a: number, b: number) => a === 0 || b === 0 || Math.abs(a - b) <= SAME_WINDOW;

export function message(a: Alert, now: number): Notice {
  const cd = countdown(a.resetAt, now);
  const body = cd === '' ? 'Check your usage.' : cd === 'resetting' ? 'Resetting now.' : `Resets ${cd}.`;
  return { title: `${a.provider}: ${a.label} ${a.used}% used`, body };
}

export interface AlertsOptions {
  text?: string | null;
  clock: () => number;
  /** Shows one notification. Resolves true when it was shown; false / throw = failed. */
  deliver: (n: Notice) => Promise<boolean | void>;
  /** Called with the file text whenever the state changed. */
  persist?: (text: string) => void;
  queue?: DeliveryQueue;
}

interface Pending { alert: Alert; entries: Entry[]; tkey: string; marks: string[] }

export class Alerts {
  fired: Entry[];
  tries: Map<string, [number, number]>;
  queue: DeliveryQueue;
  private inflight = new Set<string>();
  private clock: () => number;
  private deliver: AlertsOptions['deliver'];
  private persist?: (text: string) => void;

  constructor(o: AlertsOptions) {
    this.clock = o.clock; this.deliver = o.deliver; this.persist = o.persist;
    this.queue = o.queue ?? new DeliveryQueue();
    const now = o.clock();
    this.fired = loadFired(o.text ?? null, now);
    this.tries = loadTries(o.text ?? null, now);
  }

  serialize(): string {
    const body: Record<string, unknown> = { version: VERSION, fired: this.fired };
    if (this.tries.size) body.tries = [...this.tries].map(([k, v]) => ({ k, n: v[0], t: v[1] }));
    return JSON.stringify(body);
  }

  private save(): void { try { this.persist?.(this.serialize()); } catch { /* an alert problem never reaches the refresh */ } }

  /** Resolves when every submitted delivery has finished (tests). */
  settled(): Promise<void> { return this.queue.idle(); }

  /**
   * Looks at the providers whose refresh worked. Returns the alerts submitted (a burst of more than BURST_OVER is delivered
   * as one summary notification but is still reported one by one here).
   */
  check(providers: Provider[], settings: AlertSettings, skip: ReadonlySet<string> | string[] = []): Alert[] {
    const skipSet = new Set(skip);
    const batch: Pending[] = [];
    let changed = false;
    try {
      const now = this.clock();
      const before = this.fired.length;
      this.fired = fresh(this.fired, now);
      changed = this.fired.length !== before;
      if (settings.alertsOn !== true) { if (changed) this.save(); return []; }
      const levels = [...new Set([Math.trunc(settings.alertLow), Math.trunc(settings.alertHigh)])].sort((a, b) => a - b);
      for (const p of providers) {
        if (!p.installed || skipSet.has(p.id) || skipSet.has(p.name) || p.limits.length === 0) continue;
        for (const limit of p.limits) {
          const used = usedOf(limit);
          if (used === null) continue;
          changed = this.one(p.name, limit, used, levels, now, batch) || changed;
        }
      }
      if (this.fired.length > MAX_ENTRIES) { this.fired = this.fired.slice(-MAX_ENTRIES); changed = true; }
      this.dispatch(batch, now);
    } catch { /* never reaches the refresh */ }
    if (changed) this.save();
    return batch.map((b) => b.alert);
  }

  private one(name: string, limit: Limit, used: number, levels: number[], now: number, batch: Pending[]): boolean {
    const label = String(limit.label).slice(0, MAX_TEXT), w = windowOf(limit);
    const keep: Entry[] = [];
    let changed = false;
    const have = new Set<number>();
    for (const e of this.fired) {
      if (e.p !== name || e.l !== label) keep.push(e);
      else if (!same(e.w, w)) changed = true; // an older window: the new one replaces it
      else if (used <= e.v - REARM_POINTS) changed = true; // dropped well below: armed again
      else { keep.push(e); have.add(e.v); }
    }
    this.fired = keep;
    for (const m of this.inflight) {
      const [n, lb, ww, lv] = JSON.parse(m) as [string, string, number, number];
      if (n === name && lb === label && same(ww, w)) have.add(lv);
    }
    for (const b of batch) {
      // two limits of one check can share a name (a provider listing the same label twice): count them as in flight too
      if (b.alert.provider === name && b.alert.label === label) b.entries.forEach((e) => same(e.w, w) && have.add(e.v));
    }
    const due = levels.filter((lv) => used >= lv && !have.has(lv));
    if (due.length) {
      const top = Math.max(...due);
      const alert: Alert = { provider: name, label, used: Math.trunc(used), level: top, resetAt: limit.resetAt };
      const entries = due.map((lv) => ({ p: name, l: label, w, v: lv, t: Math.trunc(now) }));
      const marks = due.map((lv) => JSON.stringify([name, label, w, lv]));
      marks.forEach((m) => this.inflight.add(m));
      batch.push({ alert, entries, tkey: `${name}|${label}|${w}|${top}`, marks });
    }
    return changed;
  }

  private dispatch(batch: Pending[], now: number): void {
    if (batch.length === 0) return;
    if (batch.length > BURST_OVER) {
      // a burst (say, the first check after a long sleep) is one notification, marked for every limit it covers
      const entries = batch.flatMap((b) => b.entries);
      const marks = batch.flatMap((b) => b.marks);
      const tkey = `burst|${batch.map((b) => b.tkey).join(',')}`.slice(0, 300);
      const n: Notice = { title: `${batch.length} limits are running high`, body: 'Open Usage Bar to see which.' };
      this.queue.submit(() => this.deliver(n), (ok) => this.done(ok, entries, tkey, marks));
      return;
    }
    for (const b of batch) {
      const n = message(b.alert, now);
      this.queue.submit(() => this.deliver(n), (ok) => this.done(ok, b.entries, b.tkey, b.marks));
    }
  }

  private done(ok: boolean, entries: Entry[], tkey: string, marks: string[]): void {
    marks.forEach((m) => this.inflight.delete(m));
    if (ok) this.tries.delete(tkey);
    else {
      const n = (this.tries.get(tkey)?.[0] ?? 0) + 1;
      this.tries.set(tkey, [n, Math.trunc(this.clock())]);
      if (n <= MAX_RETRIES) { this.save(); return; } // stays unfired: the next check tries again
      this.tries.delete(tkey); // given up: treat the window as alerted
    }
    for (const e of entries) {
      if (!this.fired.some((x) => x.p === e.p && x.l === e.l && x.v === e.v && same(x.w, e.w))) this.fired.push(e);
    }
    if (this.fired.length > MAX_ENTRIES) this.fired = this.fired.slice(-MAX_ENTRIES);
    this.save();
  }
}
