import { describe, expect, it } from 'vitest';
import { GAP, History, KEEP, MAX_SAMPLES, MAX_SERIES, describe as speak, hasHistory, load, peak, plotSegments } from '../src/core/history';
import { Limit, Provider, emptyProvider } from '../src/core/model';

const NOW = 1_800_000_000;
const H = 3600;
function prov(name: 'claude' | 'codex', ...limits: Array<[string, number]>): Provider {
  const p = emptyProvider(name, 'ok');
  p.limits = limits.map(([label, remaining]): Limit => ({ label, remaining, resetAt: null, resets: '' }));
  return p;
}

describe('sampling', () => {
  it('at most once per ten minutes', () => {
    let now = NOW; let saved = 0;
    const h = new History(null, () => now, () => { saved++; });
    const p = prov('claude', ['5h limit', 70]);
    expect(h.record([p])).toBe(true);
    for (const dt of [60, 300, 599]) { now = NOW + dt; expect(h.record([p])).toBe(false); }
    now = NOW + 600;
    expect(h.record([p])).toBe(true);
    expect(h.samples('Claude Code', '5h limit')).toEqual([[NOW, 30], [NOW + 600, 30]]);
    expect(saved).toBe(2);
  });
  it('stores used percent and clamps', () => {
    const h = new History(null, () => NOW);
    h.record([prov('claude', ['x', 130], ['y', -5], ['z', NaN], ['w', 0])]);
    expect(h.samples('Claude Code', 'x')).toEqual([[NOW, 0]]);
    expect(h.samples('Claude Code', 'y')).toEqual([[NOW, 100]]);
    expect(h.samples('Claude Code', 'z')).toEqual([]);
    expect(h.samples('Claude Code', 'w')).toEqual([[NOW, 100]]);
  });
  it('not installed and failed providers are skipped', () => {
    const h = new History(null, () => NOW);
    const g = prov('codex', ['x', 50]); g.installed = false;
    const f = emptyProvider('claude', 'unavailable');
    h.record([g, f]);
    expect(h.data).toEqual({});
  });
  it('keeps seven days and at most 1,100 samples', () => {
    let now = NOW;
    const h = new History(null, () => now);
    const p = prov('claude', ['x', 50]);
    for (let i = 0; i < 9 * 24; i++) { now = NOW + i * H; h.record([p]); }
    const s = h.samples('Claude Code', 'x');
    expect(s[0][0]).toBeGreaterThanOrEqual(now - KEEP);
    expect(s.length).toBeLessThanOrEqual(MAX_SAMPLES);
    const big: Array<[number, number]> = Array.from({ length: MAX_SAMPLES + 400 }, (_, i) => [NOW - 400 - (MAX_SAMPLES + 400 - i) * 60 + 0, 10]);
    const loaded = load(JSON.stringify({ version: 1, series: { 'a|b': big.map(([t, u]) => [Math.max(t, NOW - KEEP + 100) + 0, u]) } }), NOW);
    expect(loaded['a|b'].length).toBeLessThanOrEqual(MAX_SAMPLES);
  });
  it('at most 64 series, newest kept', () => {
    let now = NOW;
    const h = new History(null, () => now);
    for (let i = 0; i < MAX_SERIES + 10; i++) { now = NOW + i * 700; h.record([prov('claude', [`L${i}`, 50])]); }
    expect(Object.keys(h.data).length).toBe(MAX_SERIES);
    expect(h.data['Claude Code|L73']).toBeTruthy();
    expect(h.data['Claude Code|L0']).toBeUndefined();
  });
  it('a clock set back drops the future samples and keeps sampling', () => {
    let now = NOW;
    const h = new History(null, () => now);
    const p = prov('claude', ['x', 50]);
    h.record([p]);
    now = NOW + 5 * H; h.record([p]);
    now = NOW - 5 * H; // clock back by ten hours
    h.record([p]);
    expect(h.samples('Claude Code', 'x').every(([t]) => t <= now + 3600)).toBe(true);
    expect(h.samples('Claude Code', 'x').some(([t]) => t === NOW - 5 * H)).toBe(true);
  });
  it('writes the file format with a version and no account info', () => {
    let text = '';
    const h = new History(null, () => NOW, (t) => { text = t; });
    h.record([prov('claude', ['x', 50])]);
    expect(JSON.parse(text)).toEqual({ version: 1, series: { 'Claude Code|x': [[NOW, 50]] } });
  });
});

describe('strict load', () => {
  it('corrupt files give no data', () => {
    for (const t of ['{', '', '[]', 'null', '{"version":2,"series":{}}', '{"version":1,"series":[]}', '{"version":1}']) expect(Object.keys(load(t, NOW))).toEqual([]);
    expect(Object.keys(load(null, NOW))).toEqual([]);
  });
  it('bad samples are dropped one by one', () => {
    const t = JSON.stringify({ version: 1, series: { 'a|b': [[NOW - 100, 10], [NOW - 90, 'x'], [NOW - 80, 101], [NOW - 70, -1], [NOW + 9999, 5], [NOW - 8 * 86400, 5], [1.5, 5], 'q', [1], [NOW - 60, 50]], x: [[NOW, 1]], '__proto__': [[NOW, 3]] } });
    const d = load(t, NOW);
    expect(d['a|b']).toEqual([[NOW - 100, 10], [NOW - 60, 50]]);
    expect(Object.keys(d)).toEqual(['a|b']);
  });
});

describe('plot geometry', () => {
  it('points map to the box: oldest left, 0 percent at the bottom', () => {
    const segs = plotSegments([[NOW - 7 * 86400, 0], [NOW, 100]], NOW, 100, 20);
    expect(segs[0][0]).toEqual([0, 20]);
    expect(segs[segs.length - 1].at(-1)).toEqual([100, 0]);
  });
  it('gaps over two hours split, exactly two hours joins', () => {
    const n = NOW;
    expect(plotSegments([[n - 5 * H, 10], [n - 5 * H + 600, 12], [n - 2 * H, 30], [n - 2 * H + 600, 31]], n, 100, 20).map((s) => s.length)).toEqual([2, 2]);
    expect(plotSegments([[n - 4 * H, 10], [n - 2 * H, 30]], n, 100, 20).length).toBe(1);
    expect(GAP).toBe(7200);
  });
  it('a lone point between holes is a dot', () => {
    const n = NOW;
    expect(plotSegments([[n - 9 * H, 10], [n - 8 * H, 12], [n - 4 * H, 50], [n - H, 60], [n - H + 300, 61]], n, 100, 20).map((s) => s.length)).toEqual([2, 1, 2]);
  });
  it('out-of-window and NaN samples are ignored, everything stays in the box', () => {
    const n = NOW;
    const segs = plotSegments([[n - 8 * 86400, 10], [n - 600, NaN], [n - 500, 50], [n - 100, 60], [n + 999, 70]], n, 100, 20);
    expect(segs.map((s) => s.length)).toEqual([2]);
    for (const s of segs) for (const [x, y] of s) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(20); }
  });
  it('a zero-size box or fewer than two samples: nothing', () => {
    expect(plotSegments([[1, 1], [2, 2]], NOW, 0, 20)).toEqual([]);
    expect(plotSegments([[NOW - 5, 1]], NOW, 100, 20)).toEqual([]);
    expect(hasHistory([[NOW - 5, 1]], NOW)).toBe(false);
  });
  it('peak and spoken summary', () => {
    const s: Array<[number, number]> = [[NOW - 600, 20], [NOW - 300, 83], [NOW, 40]];
    expect(peak(s, NOW)).toBe(83);
    expect(peak([[NOW - 1, NaN]], NOW)).toBe(0);
    const t = speak('Claude Code', [['5h limit', s]], NOW);
    expect(t).toContain('peak 83 percent');
    expect(t).toContain('now 40 percent');
    expect(speak('A', [['x', []]], NOW)).toContain('no history');
  });
});
