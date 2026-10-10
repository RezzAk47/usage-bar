// Made-up provider responses for the browser preview and the screenshots (never real data).
import type { FetchResult, ProviderId } from './core/model';
import { zonedToEpoch } from './core/when';

export const PREVIEW_TZ = 'America/Vancouver';
export const PREVIEW_NOW = zonedToEpoch(2026, 10, 7, 15, 5, PREVIEW_TZ)! * 1000;

const iso = (s: number) => new Date(s * 1000).toISOString();

export function fixtureResponses(name: string, nowMs: number): Partial<Record<ProviderId, FetchResult>> {
  const n = nowMs / 1000;
  const at1719 = zonedToEpoch(2026, 10, 7, 17, 19, PREVIEW_TZ)!;
  const claude = (five: number, week: number, opus: number): FetchResult => ({
    id: 'claude', status: 'ok', plan: 'max', source: 'preview',
    raw: { five_hour: { utilization: five, resets_at: iso(at1719) }, seven_day: { utilization: week, resets_at: iso(n + 3 * 86400 + 4 * 3600) }, seven_day_opus: { utilization: opus, resets_at: iso(n + 86400) } },
  });
  const codex = (five: number, week: number): FetchResult => ({
    id: 'codex', status: 'ok', source: 'preview',
    raw: { plan_type: 'plus', rate_limit: { primary_window: { used_percent: five, limit_window_seconds: 18000, reset_at: Math.round(n + 3600) }, secondary_window: { used_percent: week, limit_window_seconds: 604800, reset_at: Math.round(n + 86400) } } },
  });
  switch (name) {
    case 'normal': return { claude: claude(30, 40, 10), codex: codex(20, 35) };
    case 'hostile': {
      const evil = 'Weekly\u202E evil\u200B' + 'y'.repeat(60);
      return { claude: { id: 'claude', status: 'ok', plan: 'max', raw: { five_hour: { utilization: 40, resets_at: iso(at1719) }, ['seven_day_' + evil]: { utilization: 70, resets_at: iso(n + 86400) } } }, codex: codex(10, 20) };
    }
    case 'errors': return { claude: { id: 'claude', status: 'expired' }, codex: { id: 'codex', status: 'unavailable', reason: 'HTTP 503' } };
    case 'notsigned': return { claude: { id: 'claude', status: 'not_signed_in' }, codex: { id: 'codex', status: 'not_installed' } };
    case 'empty': return { claude: { id: 'claude', status: 'not_installed' }, codex: { id: 'codex', status: 'not_installed' } };
    case 'emptyresp': return { claude: { id: 'claude', status: 'ok', raw: {} }, codex: codex(10, 20) };
    default: return { claude: claude(40, 70, 20), codex: codex(10, 95) }; // critical: the Mac preview's numbers
  }
}

/** A week of sawtooth history for the sparklines, with a gap of a day and a half in the middle. */
export function fixtureHistory(nowMs: number): string {
  const n = Math.floor(nowMs / 1000);
  const series: Record<string, Array<[number, number]>> = {};
  const make = (key: string, period: number, top: number, phase: number) => {
    const out: Array<[number, number]> = [];
    for (let t = n - 7 * 86400 + 600; t <= n - 600; t += 1800) {
      if (t > n - 4 * 86400 && t < n - 2.5 * 86400) continue; // gap
      const x = ((t + phase) % period) / period;
      out.push([t, Math.round(top * x * 10) / 10]);
    }
    series[key] = out;
  };
  make('Claude Code|5h limit', 5 * 3600, 99, 0);
  make('Claude Code|Weekly limit', 7 * 86400, 70, 3 * 86400);
  make('Codex CLI|5h limit', 5 * 3600, 98, 2 * 3600);
  make('Codex CLI|Weekly limit', 7 * 86400, 95, 86400);
  return JSON.stringify({ version: 1, series });
}
