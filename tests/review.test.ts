// Permanent tests for the security review items (hostile provider text, refresh cooldown, persisted backoff, wake stagger,
// tray text, settings keys, Mac-model coercions).
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/ui/engine';
import { memoryBackend, type MemoryOptions } from '../src/backend/memory';
import { FetchSchedule, cleanText, nextDelay, scrub, stateOf, emptyProvider } from '../src/core/model';
import { providerFromFetch } from '../src/core/parse';
import { defaultSettings, parseSettings, settingsToObject } from '../src/core/settings';
import { trayText } from '../src/core/tray';

const NOW = 1_800_000_000_000;
const ok = (five: number) => ({ id: 'claude' as const, status: 'ok' as const, raw: { five_hour: { utilization: five, resets_at: 1_800_003_600 } } });
function rig(responses: MemoryOptions['responses'], opts: MemoryOptions = {}) {
  const b = memoryBackend({ now: NOW, responses, ...opts });
  let t = NOW; b.now = () => t;
  const e = new Engine(b, () => 0.5);
  return { b, e, advance: (s: number) => { t += s * 1000; } };
}

describe('hostile provider text (item 10)', () => {
  const evil = 'Weekly\u202E evil\u200B\u2066x\u2069\u0007\u2028' + 'y'.repeat(80);
  it('cleanText removes bidi, zero-width and control characters and caps', () => {
    expect(cleanText('a\u202Eb\u200Bc\uFEFFd\u2028e\u0007f\u2066g\u2069', 50)).toBe('abcdefg');
    expect(cleanText('x'.repeat(100), 40).length).toBe(40);
    expect(scrub('ok\u202Eevil\nline')).toBe('okevil line');
  });
  it('window labels, plan names and reasons are clean and at most 40 characters', () => {
    const raw = { [`seven_day_${evil}`]: { utilization: 10 }, five_hour: { utilization: 5 } };
    const p = providerFromFetch({ id: 'claude', status: 'ok', plan: 'max\u202E', raw }, 1);
    for (const l of p.limits) { expect(l.label).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u0007]/); expect(l.label.length).toBeLessThanOrEqual(40); }
    expect(p.tier).toBe('Max plan');
    const u = providerFromFetch({ id: 'codex', status: 'unavailable', reason: 'bad\u202Ereason' }, 1);
    expect(u.notes[0]).toBe('usage unavailable (badreason)');
  });
  it('codex extra-limit group names are clean too', () => {
    const raw = { additional_rate_limits: [{ limit_name: 'sp\u202Eark', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } } }] };
    expect(providerFromFetch({ id: 'codex', status: 'ok', raw }, 1).limits[0].label).toBe('Spark 5h');
  });
});

describe('manual refresh cooldown (item 11)', () => {
  it('a second click within 10 s does nothing; after 10 s it works', async () => {
    const { b, e, advance } = rig({ claude: ok(10), codex: { id: 'codex', status: 'not_installed' } });
    await e.start(); await e.first;
    advance(100);
    await e.refreshNow();
    const n = b.fetches.length;
    expect(e.cooldownLeft()).toBe(10);
    advance(5); await e.refreshNow();
    expect(b.fetches.length).toBe(n);
    expect(e.cooldownLeft()).toBe(5);
    advance(5); await e.refreshNow();
    expect(b.fetches.length).toBeGreaterThan(n);
  });
});

describe('the wall clock is set back', () => {
  it('the schedule does not stall: a next time further ahead than any backoff means the clock moved back', () => {
    const s = new FetchSchedule(['claude'], () => 0.5);
    s.record('claude', true, 1_800_000_000); // next fetch at +60 s
    expect(s.due(1_800_000_000 + 61)).toEqual(['claude']);
    // the user (or a big NTP correction) sets the clock back one hour: refreshes must not stop for an hour
    expect(s.due(1_800_000_000 - 3600)).toEqual(['claude']);
    // a normal wait is still respected
    s.record('claude', false, 1_800_000_000);
    expect(s.due(1_800_000_000 + 1)).toEqual([]);
  });

  it('the Refresh button cooldown never exceeds 10 s', async () => {
    const { e, advance } = rig({ claude: ok(10), codex: { id: 'codex', status: 'not_installed' } });
    await e.start(); await e.first;
    advance(100);
    await e.refreshNow();
    advance(-3600); // clock set back one hour
    expect(e.cooldownLeft()).toBeLessThanOrEqual(10);
  });
});

describe('backoff survives a restart and a wake is staggered (item 11)', () => {
  it('failures and next-allowed time are saved and loaded', async () => {
    const down = { id: 'claude' as const, status: 'unavailable' as const, reason: 'x' };
    const a = rig({ claude: down, codex: { id: 'codex', status: 'not_installed' } });
    await a.e.start(); await a.e.first; await a.e.flush();
    const text = (await a.b.io.read('usage-backoff.json'))!;
    expect(JSON.parse(text).p.claude.f).toBe(1);
    const b = rig({ claude: ok(10), codex: { id: 'codex', status: 'not_installed' } }, { });
    await b.b.io.write('usage-backoff.json', text);
    await b.e.start(); await b.e.first;
    expect(b.b.fetches.includes('claude')).toBe(false); // still waiting out the 120 s
    expect(b.e.schedule.failures.claude).toBe(1);
    expect(b.b.fetches.includes('codex')).toBe(true);
  });
  it('strict load and clock-back clamp (never more than 10 minutes ahead)', () => {
    const s = new FetchSchedule(['claude', 'codex']);
    s.load(JSON.stringify({ version: 1, p: { claude: { f: 3, t: 5_000_000_000 }, codex: { f: 'x', t: 1 } } }), 1_000);
    expect(s.nextAt.claude).toBe(1_600);
    expect(s.failures.claude).toBe(3);
    expect(s.nextAt.codex).toBeUndefined();
    for (const junk of ['', '{', '[]', 'null', '{"version":2}', '{"version":1,"p":5}', '{"version":1,"p":{"claude":{"f":-1,"t":1}}}', '{"version":1,"p":{"claude":{"f":1.5,"t":1}}}']) {
      const z = new FetchSchedule(['claude']); z.load(junk, 1_000);
      expect(z.nextAt.claude).toBeUndefined();
    }
    const out = new FetchSchedule(['claude']); out.record('claude', false, 100);
    expect(JSON.parse(out.serialize())).toEqual({ version: 1, p: { claude: { f: 1, t: out.nextAt.claude } } });
  });
  it('after wake the two providers wait different 5 to 15 s', () => {
    const seq = [0.1, 0.9]; let i = 0;
    const s = new FetchSchedule(['claude', 'codex'], () => seq[i++ % 2]);
    s.stagger(1000);
    expect(s.nextAt.claude).toBe(1006);
    expect(s.nextAt.codex).toBe(1014);
    expect(s.due(1000)).toEqual([]);
    expect(s.due(1006)).toEqual(['claude']);
  });
  it('a wake does not shorten an existing backoff', () => {
    const s = new FetchSchedule(['claude'], () => 0);
    s.nextAt.claude = 5000; s.stagger(1000);
    expect(s.nextAt.claude).toBe(5000);
  });
});

describe('tray text, settings and Mac-model coercions (items 12, 13, 2)', () => {
  it('always says left', () => {
    for (const used of [0, 37, 70, 95]) {
      const p = emptyProvider('claude', 'ok'); p.limits = [{ label: 'x', remaining: 100 - used, resetAt: null, resets: '' }];
      expect(trayText([p])).toBe(`${100 - used}% left`);
    }
    expect(trayText([emptyProvider('claude', 'unavailable')])).toBe('');
  });
  it('use_system_proxy and codex_path are strict, default off, and written back', () => {
    expect(defaultSettings()).toMatchObject({ useSystemProxy: false, codexPath: '' });
    const p = parseSettings('{"use_system_proxy":true,"codex_path":"  /opt/bin/codex  "}');
    expect(p.settings).toMatchObject({ useSystemProxy: true, codexPath: '/opt/bin/codex' });
    const bad = parseSettings('{"use_system_proxy":"yes","codex_path":"/a\\nb"}').settings;
    expect(bad).toMatchObject({ useSystemProxy: false, codexPath: '' });
    expect(settingsToObject(p.settings, p.extra)).toMatchObject({ use_system_proxy: true, codex_path: '/opt/bin/codex' });
  });
  it('state and delay read numeric strings and booleans like the Mac model', () => {
    expect(stateOf('5')).toBe('critical');
    expect(stateOf(true)).toBe('critical');
    expect(stateOf(false)).toBe('critical');
    expect(stateOf('x')).toBe('healthy');
    expect(stateOf('')).toBe('healthy');
    expect(nextDelay('3')).toBe(480);
    expect(nextDelay(true)).toBe(120);
    expect(nextDelay('x')).toBe(60);
  });
});
