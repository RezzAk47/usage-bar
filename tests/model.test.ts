import { describe, expect, it } from 'vitest';
import { FetchSchedule, Limit, Provider, backoffFailures, emptyProvider, health, isFailed, layoutRows, mergeStale, nextDelay, pickRows, scrub, stateOf, worstRemaining } from '../src/core/model';

const lim = (label: string, remaining: number): Limit => ({ label, remaining, resetAt: null, resets: '' });
function prov(id: 'claude' | 'codex', ...limits: Array<[string, number]>): Provider {
  const p = emptyProvider(id, 'ok');
  p.limits = limits.map(([l, r]) => lim(l, r));
  return p;
}
const failed = (id: 'claude' | 'codex') => { const p = emptyProvider(id, 'unavailable'); p.notes = ['usage unavailable (URLError)']; return p; };

describe('state and worst', () => {
  it('thresholds', () => {
    expect([null, 50, 29, 9, 0, 'nan', NaN, undefined].map((x) => stateOf(x))).toEqual(['healthy', 'healthy', 'warning', 'critical', 'critical', 'healthy', 'healthy', 'healthy']);
    expect(stateOf(10)).toBe('warning');
    expect(stateOf(30)).toBe('healthy');
  });
  it('worst across providers', () => {
    expect(worstRemaining([prov('claude', ['5h limit', 78], ['Weekly limit', 25]), prov('codex', ['x', 0])])).toBe(0);
    expect(worstRemaining([emptyProvider('claude', 'not_installed')])).toBeNull();
  });
});

describe('backoff', () => {
  it('120 / 240 / 480 then 600', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map((n) => nextDelay(n))).toEqual([60, 120, 240, 480, 600, 600, 600]);
  });
  it('garbage counts as no failures', () => {
    expect([nextDelay(null), nextDelay(-3), nextDelay(NaN), nextDelay('x')]).toEqual([60, 60, 60, 60]);
  });
  it('backoffFailures is the fewest among tracked providers', () => {
    expect(backoffFailures({ a: 3, b: 0 })).toBe(0);
    expect(backoffFailures({})).toBe(0);
  });
  it('a dead provider does not back off the healthy one, and the first failure counts', () => {
    const s = new FetchSchedule(['claude', 'codex'], () => 0.5);
    expect(s.due(1000)).toEqual(['claude', 'codex']);
    expect(s.record('claude', false, 1000)).toBe(120); // first fetch failed
    expect(s.record('codex', true, 1000)).toBe(60);
    expect(s.due(1059)).toEqual([]);
    expect(s.due(1060)).toEqual(['codex']);
    expect(s.due(1120)).toEqual(['claude', 'codex']);
    expect(s.record('claude', false, 1120)).toBe(240);
    expect(s.record('claude', false, 1360)).toBe(480);
    expect(s.record('claude', false, 1840)).toBe(600);
    expect(s.record('claude', false, 2440)).toBe(600);
    expect(s.record('claude', true, 3040)).toBe(60); // recovered
  });
  it('jitter stays within 10 percent', () => {
    for (const r of [0, 1, 0.5]) {
      const s = new FetchSchedule(['a'], () => r);
      s.record('a', true, 0);
      expect(s.nextAt.a).toBeGreaterThanOrEqual(54);
      expect(s.nextAt.a).toBeLessThanOrEqual(66);
    }
  });
});

describe('stale handling', () => {
  it('failed refresh keeps the last good numbers and is flagged', () => {
    const good = [prov('claude', ['5h limit', 37]), prov('codex', ['5h limit', 100])];
    const next = [failed('claude'), prov('codex', ['5h limit', 90])];
    const m = mergeStale(next, good);
    expect(m.stale).toBe(true);
    expect(worstRemaining(m.providers)).toBe(37);
    expect(m.providers[1].limits[0].remaining).toBe(90);
    expect(mergeStale(next, []).stale).toBe(true); // nothing to fall back on: still a failure
    expect(mergeStale(good, good).stale).toBe(false);
  });
  it('health and isFailed', () => {
    expect(health([failed('claude'), prov('codex', ['x', 5]), emptyProvider('codex', 'not_installed')])).toEqual({ claude: false, codex: true });
    const exp = emptyProvider('claude', 'expired');
    expect(isFailed(exp)).toBe(true);
    expect(isFailed(emptyProvider('claude', 'not_signed_in'))).toBe(false);
  });
});

describe('row picking', () => {
  const ps = [prov('claude', ['5h limit', 60], ['Weekly limit', 30], ['Opus', 90], ['Sonnet', 80]), prov('codex', ['5h limit', 50], ['Weekly limit', 10])];
  it('a row per provider first, lowest first', () => {
    expect(pickRows(ps, 2)).toEqual([[1, 1], [0, 1]]);
    expect(pickRows(ps, 1)).toEqual([[1, 1]]);
    expect(pickRows(ps, 0)).toEqual([]);
  });
  it('extra rows go to the lowest remaining overall', () => {
    expect(pickRows(ps, 4)).toEqual([[1, 1], [0, 1], [1, 0], [0, 0]]);
  });
  it('not-installed providers never take rows', () => {
    const g = emptyProvider('codex', 'not_installed');
    expect(pickRows([g, ...ps], 3).every(([pi]) => pi !== 0)).toBe(true);
  });
  it('hidden notes are per provider', () => {
    const v = layoutRows(ps, 2);
    expect(v[0].hiddenNote).toBe('+3 more limits hidden (Settings)');
    expect(v[1].hiddenNote).toBe('+1 more limit hidden (Settings)');
    expect(v[0].shown.map((l) => l.label)).toEqual(['Weekly limit']);
  });
  it('a failed provider shows its notes, a missing one says Not installed', () => {
    const v = layoutRows([failed('claude'), emptyProvider('codex', 'not_installed')], 5);
    expect(v[0].notes).toEqual(['usage unavailable (URLError)']);
    expect(v[1].notes).toEqual(['Not installed']);
  });
  it('NaN rows limit is zero rows', () => expect(pickRows(ps, NaN)).toEqual([]));
});

describe('scrub', () => {
  it('removes token-like strings and control characters', () => {
    expect(scrub('Bearer abc.def-ghi')).toBe('Bearer [redacted]');
    expect(scrub('x sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA y')).toBe('x [redacted] y');
    expect(scrub('a\nb\u0000c')).toBe('a b c');
    expect(scrub('plain text ok')).toBe('plain text ok');
    expect(scrub('z'.repeat(500)).length).toBeLessThan(30);
  });
});
