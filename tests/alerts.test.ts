import { beforeEach, describe, expect, it } from 'vitest';
import { Alert, Alerts, AlertSettings, BURST_OVER, MAX_ENTRIES, MAX_RETRIES, message } from '../src/core/alerts';
import { Limit, Provider, emptyProvider } from '../src/core/model';

const NOW = 1_800_000_000;
const DAY = 86400;

function prov(name: 'claude' | 'codex', ...limits: Array<[string, number, number | null]>): Provider {
  const p = emptyProvider(name, 'ok');
  p.limits = limits.map(([label, used, reset]): Limit => ({ label, remaining: 100 - used, resetAt: reset, resets: '' }));
  return p;
}
const failed = (id: 'claude' | 'codex') => { const p = emptyProvider(id, 'unavailable'); p.notes = ['usage unavailable (URLError)']; return p; };
const ON: AlertSettings = { alertsOn: true, alertLow: 80, alertHigh: 95 };

class Rig {
  now = NOW;
  shown: Array<{ title: string; body: string }> = [];
  result: boolean | 'throw' = true;
  saved: string | null = null;
  settings = ON;
  make(text: string | null = this.saved): Alerts {
    return new Alerts({
      text, clock: () => this.now, persist: (t) => { this.saved = t; },
      deliver: async (n) => { if (this.result === 'throw') throw new Error('x'); if (this.result) this.shown.push(n); return this.result; },
    });
  }
  async run(a: Alerts, ...ps: Provider[]) { const s = a.check(ps, this.settings); await a.settled(); return s; }
}
let rig: Rig;
beforeEach(() => { rig = new Rig(); });

describe('thresholds', () => {
  it('below the low level: nothing', async () => {
    await rig.run(rig.make(), prov('claude', ['5h limit', 79, NOW + 3600]));
    expect(rig.shown).toEqual([]);
  });
  it('80 alerts once, 95 alerts once more', async () => {
    const a = rig.make();
    const p = (u: number) => prov('claude', ['5h limit', u, NOW + 3600]);
    const s1 = await rig.run(a, p(80));
    expect(s1.map((x) => [x.level, x.used])).toEqual([[80, 80]]);
    await rig.run(a, p(85)); await rig.run(a, p(90));
    expect(rig.shown.length).toBe(1);
    await rig.run(a, p(95));
    expect(rig.shown.length).toBe(2);
    await rig.run(a, p(99));
    expect(rig.shown.length).toBe(2);
  });
  it('jumping past both sends one, for the highest, and not the lower one late', async () => {
    const a = rig.make();
    const s = await rig.run(a, prov('codex', ['Weekly limit', 97, NOW + 3600]));
    expect(s.map((x) => x.level)).toEqual([95]);
    await rig.run(a, prov('codex', ['Weekly limit', 98, NOW + 3600]));
    expect(rig.shown.length).toBe(1);
  });
  it('each provider and limit alerts separately', async () => {
    await rig.run(rig.make(), prov('claude', ['5h limit', 90, NOW + 3600], ['Weekly limit', 90, NOW + DAY]), prov('codex', ['5h limit', 90, NOW + 3600]));
    expect(rig.shown.length).toBe(3);
  });
  it('custom thresholds, equal thresholds, master switch', async () => {
    rig.settings = { alertsOn: true, alertLow: 60, alertHigh: 70 };
    expect((await rig.run(rig.make(), prov('claude', ['5h limit', 65, NOW + 3600]))).map((x) => x.level)).toEqual([60]);
    rig = new Rig(); rig.settings = { alertsOn: true, alertLow: 90, alertHigh: 90 };
    await rig.run(rig.make(), prov('claude', ['5h limit', 91, NOW + 3600]));
    expect(rig.shown.length).toBe(1);
    rig = new Rig(); rig.settings = { ...ON, alertsOn: false };
    await rig.run(rig.make(), prov('claude', ['5h limit', 99, NOW + 3600]));
    expect(rig.shown).toEqual([]);
  });
  it('turning alerts back on alerts once', async () => {
    const a = rig.make();
    const high = prov('claude', ['5h limit', 99, NOW + 3600]);
    rig.settings = { ...ON, alertsOn: false }; await rig.run(a, high);
    rig.settings = ON; await rig.run(a, high); await rig.run(a, high);
    expect(rig.shown.length).toBe(1);
  });
  it('not installed and NaN are ignored', async () => {
    const a = rig.make();
    const g = prov('codex', ['5h limit', 99, null]); g.installed = false;
    const n = prov('claude', ['5h limit', 0, null]); n.limits[0].remaining = NaN;
    await rig.run(a, g, n);
    expect(rig.shown).toEqual([]);
  });
});

describe('windows', () => {
  it('a new window re-arms', async () => {
    const a = rig.make();
    await rig.run(a, prov('claude', ['5h limit', 85, NOW + 3600]));
    await rig.run(a, prov('claude', ['5h limit', 85, NOW + 3600 + 5 * 3600]));
    expect(rig.shown.length).toBe(2);
  });
  it('reset jitter of up to 300 s is the same window', async () => {
    const a = rig.make();
    await rig.run(a, prov('claude', ['5h limit', 85, NOW + 3600]));
    for (const j of [60, -60, 299, -300, 300]) await rig.run(a, prov('claude', ['5h limit', 85, NOW + 3600 + j]));
    expect(rig.shown.length).toBe(1);
  });
  it('a None reset matches the same level', async () => {
    const a = rig.make();
    await rig.run(a, prov('claude', ['5h limit', 90, NOW + 3600]));
    await rig.run(a, prov('claude', ['5h limit', 90, null]));
    expect(rig.shown.length).toBe(1);
    const b = new Rig();
    const a2 = b.make();
    for (let i = 0; i < 3; i++) await b.run(a2, prov('claude', ['Extra usage', 90, null]));
    expect(b.shown.length).toBe(1);
  });
  it('falling 5 points below re-arms, 4 does not', async () => {
    const a = rig.make();
    const w = NOW + 3600;
    await rig.run(a, prov('claude', ['5h limit', 82, w]));
    await rig.run(a, prov('claude', ['5h limit', 76, w]));
    await rig.run(a, prov('claude', ['5h limit', 82, w]));
    expect(rig.shown.length).toBe(1);
    await rig.run(a, prov('claude', ['5h limit', 75, w]));
    await rig.run(a, prov('claude', ['5h limit', 80, w]));
    expect(rig.shown.length).toBe(2);
  });
});

describe('failed and stale providers', () => {
  it('a failed provider never alerts, nor does a skipped one', async () => {
    const a = rig.make();
    await rig.run(a, failed('claude'));
    a.check([prov('claude', ['5h limit', 99, NOW + 3600])], ON, ['claude']);
    await a.settled();
    expect(rig.shown).toEqual([]);
  });
});

describe('persistence', () => {
  it('a restart does not repeat', async () => {
    const high = prov('claude', ['5h limit', 90, NOW + 3600]);
    await rig.run(rig.make(), high);
    await rig.run(rig.make(), high);
    expect(rig.shown.length).toBe(1);
  });
  it('the file is small JSON without account info', async () => {
    await rig.run(rig.make(), prov('claude', ['5h limit', 90, NOW + 3600]));
    const raw = JSON.parse(rig.saved!);
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.fired[0]).sort()).toEqual(['l', 'p', 't', 'v', 'w']);
  });
  it('corrupt files are ignored', async () => {
    for (const content of ['{not json', '', '[]', '{"version":2,"fired":[]}', '{"version":1,"fired":"x"}', '{"version":1,"fired":[1,null,{"p":1}]}', 'null', '\u0000\u0001']) {
      const r = new Rig();
      await r.run(r.make(content), prov('claude', ['5h limit', 90, NOW + 3600]));
      expect(r.shown.length, content).toBe(1);
    }
  });
  it('bad entries are dropped, good ones kept', async () => {
    const good = { p: 'Claude Code', l: '5h limit', w: NOW + 3600, v: 80, t: NOW };
    const a = rig.make(JSON.stringify({ version: 1, fired: [good, { p: 'x' }, { ...good, v: '80' }, { ...good, t: true }, 5, { ...good, v: 80.5 }, { ...good, extra: 1 }] }));
    expect(a.fired.length).toBe(1);
    await rig.run(a, prov('claude', ['5h limit', 85, NOW + 3600]));
    expect(rig.shown).toEqual([]);
  });
  it('entries older than 8 days are pruned', async () => {
    const old = { p: 'Claude Code', l: '5h limit', w: NOW - 9 * DAY, v: 80, t: NOW - 9 * DAY };
    const fresh = { p: 'Codex CLI', l: '5h limit', w: NOW + 100, v: 80, t: NOW - 7 * DAY };
    const a = rig.make(JSON.stringify({ version: 1, fired: [old, fresh] }));
    expect(a.fired.map((e) => e.p)).toEqual(['Codex CLI']);
    rig.now = NOW + 2 * DAY;
    a.check([prov('codex', ['x', 10, null])], ON);
    expect(a.fired).toEqual([]);
  });
  it('the entry count is capped', async () => {
    const a = rig.make();
    const many = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => { const p = prov('claude', ['5h limit', 90, NOW + 3600]); p.name = `P${i}`; return p; });
    await rig.run(a, ...many);
    expect(a.fired.length).toBeLessThanOrEqual(MAX_ENTRIES);
  });
  it('a persist that throws does not crash the check', async () => {
    const a = new Alerts({ clock: () => NOW, deliver: async () => true, persist: () => { throw new Error('disk full'); } });
    expect(() => a.check([prov('claude', ['5h limit', 90, NOW + 3600])], ON)).not.toThrow();
    await a.settled();
  });
});

describe('clock jumps', () => {
  it('a clock set back does not alert the same window again', async () => {
    const a = rig.make();
    const p = prov('claude', ['5h limit', 90, NOW + 3600]);
    await rig.run(a, p);
    rig.now = NOW - 3 * DAY; // the clock went back three days
    await rig.run(a, p); await rig.run(a, p);
    expect(rig.shown.length).toBe(1);
  });
  it('a clock set far forward prunes old keys and alerts a new window once', async () => {
    const a = rig.make();
    await rig.run(a, prov('claude', ['5h limit', 90, NOW + 3600]));
    rig.now = NOW + 30 * DAY;
    await rig.run(a, prov('claude', ['5h limit', 90, rig.now + 3600]));
    expect(rig.shown.length).toBe(2);
  });
  it('junk entries far in the future are dropped on load', () => {
    const junk = { p: 'Claude Code', l: '5h limit', w: 0, v: 80, t: NOW + 1000 * DAY };
    expect(rig.make(JSON.stringify({ version: 1, fired: [junk] })).fired).toEqual([]);
  });
});

describe('delivery', () => {
  it('message text', () => {
    const a: Alert = { provider: 'Claude Code', label: '5h limit', used: 96, level: 95, resetAt: NOW + 2 * 3600 + 14 * 60 };
    expect(message(a, NOW)).toEqual({ title: 'Claude Code: 5h limit 96% used', body: 'Resets in 2 h 14 min.' });
    expect(message({ ...a, resetAt: null }, NOW).body).toBe('Check your usage.');
    expect(message({ ...a, resetAt: NOW - 5 }, NOW).body).toBe('Resetting now.');
  });
  it('a failed delivery is not marked, retried on later checks, saved, and dropped after MAX_RETRIES', async () => {
    rig.result = false;
    const a = rig.make();
    const p = prov('claude', ['5h limit', 96, NOW + 3600]);
    expect(a.fired).toEqual([]);
    for (let i = 0; i < MAX_RETRIES; i++) { await rig.run(a, p); expect(a.fired).toEqual([]); }
    expect(JSON.parse(rig.saved!).tries.length).toBe(1);
    // the retry count survives a restart
    const b = rig.make();
    expect(b.tries.size).toBe(1);
    await rig.run(b, p); // the 4th failure: given up, window counts as alerted (levels 80 and 95)
    expect(b.fired.length).toBe(2);
    rig.result = true;
    await rig.run(b, p);
    expect(rig.shown).toEqual([]);
  });
  it('a throwing delivery counts as failed and never reaches the caller', async () => {
    rig.result = 'throw';
    const a = rig.make();
    await rig.run(a, prov('claude', ['5h limit', 96, NOW + 3600]));
    expect(a.fired).toEqual([]);
    rig.result = true;
    await rig.run(a, prov('claude', ['5h limit', 96, NOW + 3600]));
    expect(rig.shown.length).toBe(1);
    expect(a.fired.length).toBeGreaterThan(0);
  });
  it('success is required: only after delivery does the window count', async () => {
    let release!: (v: boolean) => void;
    const a = new Alerts({ clock: () => NOW, deliver: () => new Promise<boolean>((r) => { release = r; }) });
    a.check([prov('claude', ['5h limit', 96, NOW + 3600])], ON);
    expect(a.fired).toEqual([]);
    a.check([prov('claude', ['5h limit', 96, NOW + 3600])], ON); // in flight: not submitted twice
    release(true);
    await a.settled();
    expect(a.fired.length).toBe(2); // levels 80 and 95 were both due
  });
  it('a burst of more than 3 is one notification', async () => {
    const a = rig.make();
    const ps = Array.from({ length: BURST_OVER + 2 }, (_, i) => prov('claude', [`W${i}`, 90, NOW + 3600]));
    const sent = await rig.run(a, ...ps);
    expect(sent.length).toBe(BURST_OVER + 2);
    expect(rig.shown).toEqual([{ title: '5 limits are running high', body: 'Open Usage Bar to see which.' }]);
    await rig.run(a, ...ps);
    expect(rig.shown.length).toBe(1); // all five are marked
  });
  it('exactly 3 are three notifications', async () => {
    await rig.run(rig.make(), prov('claude', ['a', 90, NOW + 3600], ['b', 90, NOW + 3600], ['c', 90, NOW + 3600]));
    expect(rig.shown.length).toBe(3);
  });
});
