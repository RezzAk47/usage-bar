// The usage model: providers, limits, the "left" maths, row picking, stale handling, state colours and refresh backoff.
// Mirrors the behaviour of the Mac usage bar, on structured data instead of text rows.
import { isFiniteNumber } from './num';

export type ProviderId = 'claude' | 'codex';
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex CLI' };
export const SIGN_IN_TOOL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface Limit {
  label: string;
  /** Whole percent left, 0..100. 100 only when nothing is used. */
  remaining: number;
  /** Absolute reset time, epoch seconds, when the provider gave one. */
  resetAt: number | null;
  /** The reset as text for the sub-line ("resets 17:19"); '' = unknown. Filled by the caller (needs a clock and a zone). */
  resets: string;
}

export type Status = 'ok' | 'not_installed' | 'not_signed_in' | 'expired' | 'unavailable';

export interface Provider {
  id: ProviderId;
  name: string;
  installed: boolean;
  status: Status;
  account: string;
  tier: string;
  limits: Limit[];
  notes: string[];
  /** Rows that look like limits but could not be read. */
  unreadable: number;
}

/** What Rust sends back for one provider (never a token). `raw` is the provider's JSON response, depth-capped. */
export interface FetchResult {
  id: ProviderId;
  status: Status;
  /** Short, scrubbed reason for 'unavailable'. */
  reason?: string;
  /** Plan name read from the credentials file (Claude: subscriptionType). Not a secret. */
  plan?: string;
  raw?: unknown;
  /** Which source answered, for the README / debugging: 'http' or 'app-server'. */
  source?: string;
}

/** used percent (any number) to whole percent left. 0.5 used reads 99 left; 100 left only when used is 0. */
export function remainingFromUsed(used: number): number {
  const u = Math.min(100, Math.max(0, used));
  return Math.max(0, Math.min(100, Math.floor(100 - u)));
}

export function emptyProvider(id: ProviderId, status: Status = 'unavailable'): Provider {
  return { id, name: PROVIDER_NAMES[id], installed: status !== 'not_installed', status, account: '', tier: '', limits: [], notes: [], unreadable: 0 };
}

export const worst = (p: Provider): number | null => (p.limits.length ? Math.min(...p.limits.map((l) => l.remaining)) : null);

export function worstRemaining(providers: Provider[]): number | null {
  let best: number | null = null;
  for (const p of providers) {
    const w = worst(p);
    if (w !== null && (best === null || w < best)) best = w;
  }
  return best;
}

export type Health = 'critical' | 'warning' | 'healthy';
/** 'critical' under 10, 'warning' under 30, else 'healthy' (null / NaN count as healthy). */
export function stateOf(remaining: unknown): Health {
  // the Mac model reads float(x): numeric strings and booleans count (kept for parity; real data is always a number)
  if (typeof remaining === 'boolean') remaining = remaining ? 1 : 0;
  else if (typeof remaining === 'string' && remaining.trim() !== '') remaining = Number(remaining);
  if (!isFiniteNumber(remaining)) return 'healthy';
  return remaining < 10 ? 'critical' : remaining < 30 ? 'warning' : 'healthy';
}

/** An installed provider whose refresh just failed (no limits): the network said no, the token ran out, or the reply was empty. */
export function isFailed(p: Provider): boolean {
  return p.installed && p.limits.length === 0 && (p.status === 'unavailable' || p.status === 'expired');
}

/**
 * Keeps the last good numbers of a provider whose refresh just failed. Returns the provider to show and whether it is
 * stale. A first fetch with nothing to fall back on is stale too (it still counts as a failure for the backoff).
 */
export function mergeStaleOne(next: Provider, prev: Provider | undefined): { provider: Provider; stale: boolean } {
  if (!isFailed(next)) return { provider: next, stale: false };
  return { provider: prev && prev.limits.length ? prev : next, stale: true };
}

export function mergeStale(next: Provider[], prev: Provider[]): { providers: Provider[]; stale: boolean } {
  let stale = false;
  const providers = next.map((p) => {
    const m = mergeStaleOne(p, prev.find((o) => o.id === p.id));
    stale ||= m.stale;
    return m.provider;
  });
  return { providers, stale };
}

/** {id: true/false} for providers that tell us something: true = limits came back, false = the refresh failed. */
export function health(next: Provider[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of next) if (p.installed && (p.limits.length || isFailed(p))) out[p.id] = !isFailed(p);
  return out;
}

/** Failures that drive one shared delay: the fewest among tracked providers (one dead provider cannot slow a healthy one). */
export function backoffFailures(counts: Record<string, number>): number {
  const v = Object.values(counts);
  return v.length ? Math.min(...v) : 0;
}

export const REFRESH_SECONDS = 60;
export const MAX_BACKOFF_SECONDS = 600;

/** Seconds until the next refresh: 60 when healthy, 120 / 240 / 480 / 600 after 1 / 2 / 3 / 4+ failures. */
export function nextDelay(failures: unknown, base = REFRESH_SECONDS, cap = MAX_BACKOFF_SECONDS): number {
  const f = typeof failures === 'boolean' ? Number(failures) : typeof failures === 'string' && /^\s*-?\d+\s*$/.test(failures) ? Number(failures) : failures;
  const n = isFiniteNumber(f) ? Math.max(0, Math.trunc(f)) : 0;
  return Math.min(cap, base * 2 ** Math.min(n, 10));
}

/**
 * Per-provider refresh schedule. A provider is due when `now >= nextAt`; each success or failure sets its own next time
 * (jittered +-10%), so a dead provider backs off alone. The first fetch failing counts.
 */
export class FetchSchedule {
  failures: Record<string, number> = {};
  nextAt: Record<string, number> = {};
  constructor(private ids: readonly string[], private rand: () => number = Math.random) {}

  due(now: number): string[] { return this.ids.filter((id) => (this.nextAt[id] ?? 0) <= now); }

  /** Make every provider due right away (the Refresh button): backoff is skipped on purpose. */
  expedite(now: number): void { for (const id of this.ids) this.nextAt[id] = now; }

  /** After sleep: each provider waits its own 5 to 15 s so the two requests do not go out together. */
  stagger(now: number): void { for (const id of this.ids) this.nextAt[id] = Math.max(this.nextAt[id] ?? 0, now + 5 + Math.round(this.rand() * 10)); }

  /** The backoff of failing providers as a file (absolute epoch seconds, so a restart keeps it). Healthy providers are not saved: after a restart they have no numbers yet and fetch at once. */
  serialize(): string {
    const p: Record<string, { f: number; t: number }> = {};
    for (const id of this.ids) if ((this.failures[id] ?? 0) > 0) p[id] = { f: this.failures[id] ?? 0, t: Math.trunc(this.nextAt[id] ?? 0) };
    return JSON.stringify({ version: 1, p });
  }

  /** Strict load: bad entries are ignored; a next-allowed time further away than 10 minutes (a clock that was set back) is cut to 10 minutes from now. */
  load(text: string | null, now: number): void {
    if (text === null || text.length > 100000) return;
    let d: unknown;
    try { d = JSON.parse(text); } catch { return; }
    if (typeof d !== 'object' || d === null || Array.isArray(d) || (d as Record<string, unknown>).version !== 1) return;
    const p = (d as { p?: unknown }).p;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return;
    for (const id of this.ids) {
      const e = (p as Record<string, unknown>)[id];
      if (typeof e !== 'object' || e === null) continue;
      const { f, t } = e as { f?: unknown; t?: unknown };
      if (!Number.isInteger(f) || !Number.isInteger(t) || (f as number) < 0 || (f as number) > 100 || (t as number) < 0 || (t as number) > 1e11) continue;
      this.failures[id] = f as number;
      this.nextAt[id] = Math.min(t as number, now + MAX_BACKOFF_SECONDS);
    }
  }

  record(id: string, ok: boolean, now: number): number {
    this.failures[id] = ok ? 0 : (this.failures[id] ?? 0) + 1;
    const delay = nextDelay(this.failures[id]);
    const jitter = 1 + (this.rand() * 2 - 1) * 0.1;
    this.nextAt[id] = now + Math.round(delay * jitter);
    return delay;
  }
}

/**
 * Which limits to show when only maxRows fit: (provider index, limit index) pairs in priority order. Every installed provider
 * with limits gets its lowest-remaining limit first (providers with the lowest limit first), then the rest go to the
 * lowest-remaining limits overall.
 */
export function pickRows(providers: Provider[], maxRows: number): Array<[number, number]> {
  const cand: Array<[number, number, number]> = [];
  providers.forEach((p, pi) => { if (p.installed) p.limits.forEach((l, li) => cand.push([pi, li, l.remaining])); });
  const best = new Map<number, [number, number, number]>();
  for (const c of cand) { const b = best.get(c[0]); if (!b || c[2] < b[2]) best.set(c[0], c); }
  const first = [...best.values()].sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  const taken = new Set(first.map((c) => `${c[0]}:${c[1]}`));
  const rest = cand.filter((c) => !taken.has(`${c[0]}:${c[1]}`)).sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  const n = Number.isFinite(maxRows) ? Math.max(0, Math.trunc(maxRows)) : 0;
  return [...first, ...rest].slice(0, n).map((c) => [c[0], c[1]]);
}

export interface ProviderView { provider: Provider; shown: Limit[]; hidden: number; hiddenNote: string; notes: string[] }

/** The rows of the popup: per provider the shown limits (original order), the '+N more limits hidden' note and other notes. */
export function layoutRows(providers: Provider[], maxRows: number): ProviderView[] {
  const chosen = new Set(pickRows(providers, maxRows).map(([a, b]) => `${a}:${b}`));
  return providers.map((p, pi) => {
    const shown = p.installed ? p.limits.filter((_l, li) => chosen.has(`${pi}:${li}`)) : [];
    const hidden = p.installed ? p.limits.length - shown.length : 0;
    const notes = !p.installed ? ['Not installed'] : p.limits.length ? [] : [...p.notes];
    if (p.unreadable) notes.push(`${p.unreadable} limit${p.unreadable > 1 ? 's' : ''} couldn't be read`);
    return { provider: p, shown, hidden, hiddenNote: hidden ? `+${hidden} more limit${hidden > 1 ? 's' : ''} hidden (Settings)` : '', notes };
  });
}

const FORMAT_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u2028\u2029\u00AD\u061C\u180E]/g;

/** Provider-controlled text made safe to display: control and bidi / zero-width format characters removed, capped. */
export function cleanText(text: string, max: number): string {
  const s = [...text.replace(FORMAT_CONTROLS, '')].filter((c) => { const n = c.codePointAt(0)!; return n >= 32 && !(n >= 0x7f && n < 0xa0); }).join('');
  return s.length > max ? s.slice(0, max) : s;
}

/** Text a token-like string would hide in. Anything long and made of token characters is replaced. */
export function scrub(text: unknown, max = 160): string {
  let s = (typeof text === 'string' ? text : String(text)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(FORMAT_CONTROLS, '');
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_\-.=+/]{24,}/g, '[redacted]');
  return s.length > max ? s.slice(0, max) + '…' : s;
}
