// Turns provider responses into limits. Tolerant on purpose: the response shapes are not documented by the providers.
import { asNumber } from './num';
import { isObject } from './json';
import { parseWhen, parseResetText } from './when';
import { FetchResult, Limit, Provider, SIGN_IN_TOOL, cleanText, emptyProvider, remainingFromUsed, scrub } from './model';

export interface Parsed { limits: Limit[]; tier: string; unreadable: number }

const mkLimit = (label: string, used: number, resetAt: number | null): Limit => ({ label: cleanText(label, 40) || 'Limit', remaining: remainingFromUsed(used), resetAt, resets: '' });

/** A reset value: epoch s / ms, ISO string, or (last resort) 'resets 17:19' text. */
function resetOf(v: unknown, now: number): number | null {
  return parseWhen(v) ?? (typeof v === 'string' ? parseResetText(v, now) : null);
}

const titleCase = (s: string) => cleanText(s, 40).replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

function claudeLabel(key: string): string {
  if (key === 'five_hour') return '5h limit';
  if (key === 'seven_day') return 'Weekly limit';
  let m = /^seven_day_(.+)$/.exec(key);
  if (m) return `Weekly ${titleCase(m[1])}`;
  m = /^five_hour_(.+)$/.exec(key);
  if (m) return `5h ${titleCase(m[1])}`;
  return titleCase(key);
}

const CLAUDE_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/**
 * Claude OAuth usage response: an object of windows, each {utilization: percent used, resets_at}. Unknown windows
 * (seven_day_*, ...) are shown too. A window whose utilization is null/missing means "no data": skipped. A window with a
 * value that is not a number counts as unreadable. `extra_usage` ({is_enabled, utilization}) becomes 'Extra usage'.
 */
export function parseClaudeUsage(raw: unknown, now: number): Parsed {
  const out: Parsed = { limits: [], tier: '', unreadable: 0 };
  if (!isObject(raw)) return out;
  const keys = Object.keys(raw);
  const ordered = [...CLAUDE_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !CLAUDE_ORDER.includes(k) && k !== 'extra_usage')];
  for (const key of ordered) {
    const w = raw[key];
    if (!isObject(w) || !('utilization' in w)) continue;
    if (w.utilization === null || w.utilization === undefined) continue;
    const used = typeof w.utilization === 'boolean' ? null : asNumber(w.utilization);
    if (used === null) { out.unreadable++; continue; }
    out.limits.push(mkLimit(claudeLabel(key), used, resetOf(w.resets_at ?? w.reset_at ?? w.resetsAt, now)));
  }
  const extra = raw.extra_usage;
  if (isObject(extra) && extra.is_enabled !== false && extra.utilization !== null && extra.utilization !== undefined) {
    const used = typeof extra.utilization === 'boolean' ? null : asNumber(extra.utilization);
    if (used === null) out.unreadable++;
    else out.limits.push(mkLimit('Extra usage', used, null));
  }
  return out;
}

function windowName(seconds: number | null, fallback: string): string {
  if (seconds === null || seconds <= 0) return fallback;
  const hours = seconds / 3600;
  if (hours <= 6) return '5h';
  if (hours >= 6 * 24 && hours <= 8 * 24) return 'Weekly';
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function codexWindow(w: unknown, fallbackName: string, group: string, now: number, out: Parsed, usedKeys: string[], resetKeys: string[]): void {
  if (!isObject(w)) return;
  let usedRaw: unknown;
  for (const k of usedKeys) if (w[k] !== undefined && w[k] !== null) { usedRaw = w[k]; break; }
  if (usedRaw === undefined) return;
  const used = typeof usedRaw === 'boolean' ? null : asNumber(usedRaw);
  if (used === null) { out.unreadable++; return; }
  let secs = asNumber(w.limit_window_seconds ?? w.window_seconds);
  if (secs === null) { const mins = asNumber(w.windowDurationMins ?? w.window_minutes); secs = mins === null ? null : mins * 60; }
  const name = windowName(secs, fallbackName);
  let resetAt: number | null = null;
  for (const k of resetKeys) if (w[k] !== undefined && w[k] !== null) { resetAt = resetOf(w[k], now); if (resetAt !== null) break; }
  if (resetAt === null) { const after = asNumber(w.reset_after_seconds); if (after !== null && after >= 0) resetAt = now + after; }
  const label = group ? `${group} ${name}` : `${name} limit`;
  out.limits.push(mkLimit(label, used, resetAt));
}

const planName = (v: unknown): string => (typeof v === 'string' && cleanText(v, 40).trim() ? `${titleCase(cleanText(v, 30).trim())} plan` : '');

/**
 * Codex usage: the web-style response {plan_type, rate_limit: {primary_window, secondary_window}, additional_rate_limits: [...]}
 * (used_percent, limit_window_seconds, reset_at / reset_after_seconds) or the app-server reply {rateLimits: {planType,
 * primary, secondary}} (usedPercent, windowDurationMins, resetsAt). Windows are named by their length: 5 hours = '5h limit',
 * about a week = 'Weekly limit'; extra metered limits are grouped under their name ('Spark 5h').
 */
export function parseCodexUsage(raw: unknown, now: number): Parsed {
  const out: Parsed = { limits: [], tier: '', unreadable: 0 };
  if (!isObject(raw)) return out;
  const U = ['used_percent', 'usedPercent'], R = ['reset_at', 'resets_at', 'resetsAt'];
  const rl = isObject(raw.rate_limit) ? raw.rate_limit : null;
  if (rl) {
    codexWindow(rl.primary_window, '5h', '', now, out, U, R);
    codexWindow(rl.secondary_window, 'Weekly', '', now, out, U, R);
    out.tier = planName(raw.plan_type);
  }
  const rls = isObject(raw.rateLimits) ? raw.rateLimits : null;
  if (rls) {
    codexWindow(rls.primary, '5h', '', now, out, U, R);
    codexWindow(rls.secondary, 'Weekly', '', now, out, U, R);
    out.tier ||= planName(rls.planType);
  }
  if (Array.isArray(raw.additional_rate_limits)) {
    for (const extra of raw.additional_rate_limits.slice(0, 20)) {
      if (!isObject(extra)) continue;
      const nameRaw = extra.limit_name ?? extra.metered_feature;
      const group = typeof nameRaw === 'string' && nameRaw.trim() ? titleCase(nameRaw.trim().slice(0, 30)) : 'Extra';
      const r = isObject(extra.rate_limit) ? extra.rate_limit : extra;
      codexWindow(r.primary_window, '5h', group, now, out, U, R);
      codexWindow(r.secondary_window, 'Weekly', group, now, out, U, R);
    }
  }
  return out;
}

/** One provider as the popup shows it, built from what Rust returned. Never throws. */
export function providerFromFetch(res: FetchResult, now: number): Provider {
  const id = res.id;
  const p = emptyProvider(id, res.status);
  try {
    if (res.status === 'not_installed') return p;
    if (res.status === 'not_signed_in') { p.notes = ['Not signed in']; return p; }
    if (res.status === 'expired') { p.notes = [`Sign in again in ${SIGN_IN_TOOL[id]}`]; return p; }
    if (res.status === 'unavailable') { p.notes = [`usage unavailable (${scrub(res.reason || 'unknown', 80)})`]; return p; }
    const parsed = id === 'claude' ? parseClaudeUsage(res.raw, now) : parseCodexUsage(res.raw, now);
    p.limits = parsed.limits; p.unreadable = parsed.unreadable;
    p.tier = parsed.tier || (res.plan ? planName(res.plan) : '');
    if (!p.limits.length) {
      p.status = 'unavailable';
      p.notes = [`usage unavailable (${parsed.unreadable ? 'unreadable response' : 'empty response'})`];
    }
  } catch {
    p.status = 'unavailable'; p.limits = []; p.notes = ['usage unavailable (unexpected response)'];
  }
  return p;
}
