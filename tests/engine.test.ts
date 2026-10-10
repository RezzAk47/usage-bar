import { describe, expect, it } from 'vitest';
import { Engine } from '../src/ui/engine';
import { memoryBackend, type MemoryOptions } from '../src/backend/memory';
import type { FetchResult } from '../src/core/model';
import { trayText, trayTooltip } from '../src/core/tray';

const NOW = 1_800_000_000_000;
const claudeOk = (five: number): FetchResult => ({ id: 'claude', status: 'ok', raw: { five_hour: { utilization: five, resets_at: 1_800_003_600 } } });
const codexOk = (five: number): FetchResult => ({ id: 'codex', status: 'ok', raw: { rate_limit: { primary_window: { used_percent: five, limit_window_seconds: 18000, reset_at: 1_800_003_600 } } } });

function rig(responses: MemoryOptions['responses'], extra: MemoryOptions = {}) {
  const b = memoryBackend({ now: NOW, responses, ...extra });
  let t = NOW;
  b.now = () => t;
  const e = new Engine(b, () => 0.5);
  return { b, e, advance: (s: number) => { t += s * 1000; } };
}

describe('Engine', () => {
  it('first refresh shows numbers, writes history, sets the tray label', async () => {
    const { b, e } = rig({ claude: claudeOk(40), codex: codexOk(10) });
    const labels: string[] = [];
    b.setTrayLabel = async (l) => { labels.push(l); };
    await e.start(); await e.first; await e.flush();
    expect(e.providers.map((p) => p.limits[0].remaining)).toEqual([60, 90]);
    expect(e.updated).toBe(NOW / 1000);
    expect(JSON.parse((await b.io.read('usage-history.json'))!).series['Claude Code|5h limit']).toEqual([[NOW / 1000, 40]]);
    expect(labels.at(-1)!.startsWith('60% left\n')).toBe(true);
  });

  it('a dead provider backs off alone, keeps its last good numbers and is flagged stale', async () => {
    let claudeUp = true;
    const { b, e, advance } = rig({ claude: async () => (claudeUp ? claudeOk(40) : { id: 'claude', status: 'unavailable', reason: 'HTTP 503' }), codex: codexOk(10) });
    await e.start(); await e.first;
    claudeUp = false;
    advance(70); await e.tick();
    expect(e.stale.has('claude')).toBe(true);
    expect(e.providers[0].limits[0].remaining).toBe(60); // last good numbers
    expect(e.schedule.failures).toEqual({ claude: 1, codex: 0 });
    const before = b.fetches.length;
    advance(70); await e.tick(); // claude waits 120 s, codex is due again
    expect(b.fetches.slice(before)).toEqual(['codex']);
    advance(60); await e.tick();
    expect(b.fetches.slice(before)).toEqual(['codex', 'claude', 'codex']);
    expect(e.schedule.failures.claude).toBe(2);
  });

  it('a first fetch that fails counts and shows the reason', async () => {
    const { e } = rig({ claude: { id: 'claude', status: 'unavailable', reason: 'timeout' }, codex: { id: 'codex', status: 'not_installed' } });
    await e.start(); await e.first;
    expect(e.schedule.failures.claude).toBe(1);
    expect(e.providers[0].notes).toEqual(['usage unavailable (timeout)']);
    expect(e.stale.has('claude')).toBe(true);
    expect(e.updated).toBeNull();
  });

  it('a fetch that throws becomes an unavailable provider (scrubbed)', async () => {
    const { e } = rig({ claude: async () => { throw new Error('boom Bearer sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); }, codex: codexOk(10) });
    await e.start(); await e.first;
    expect(e.providers[0].notes[0]).toMatch(/^usage unavailable/);
    expect(e.providers[0].notes[0]).not.toMatch(/AAAAAAAA/);
  });

  it('an empty {} response is unavailable and keeps the old numbers', async () => {
    let empty = false;
    const { e, advance } = rig({ claude: async () => (empty ? { id: 'claude', status: 'ok', raw: {} } : claudeOk(22)), codex: codexOk(10) });
    await e.start(); await e.first;
    empty = true; advance(70); await e.tick();
    expect(e.providers[0].limits[0].remaining).toBe(78);
    expect(e.stale.has('claude')).toBe(true);
  });

  it('alerts fire for fresh numbers only, once, and survive a restart', async () => {
    const { b, e } = rig({ claude: claudeOk(85), codex: codexOk(10) });
    await e.start(); await e.first; await e.alerts!.settled();
    expect(b.notices.map((n) => n.title)).toEqual(['Claude Code: 5h limit 85% used']);
    await e.alerts!.settled(); await e.flush();
    e.backend.now = () => NOW + 11_000; // past the 10 s refresh cooldown
    await e.refreshNow(); await e.alerts!.settled(); await e.flush();
    expect(b.notices.length).toBe(1);
    // restart with the saved alert file
    const b2 = memoryBackend({ now: NOW, responses: { claude: claudeOk(85), codex: codexOk(10) }, alertsJson: (await b.io.read('usage-alerts.json'))! });
    const e2 = new Engine(b2, () => 0.5);
    await e2.start(); await e2.first; await e2.alerts!.settled();
    expect(b2.notices).toEqual([]);
  });

  it('a stale provider never alerts from its old numbers', async () => {
    let up = true;
    const { b, e, advance } = rig({ claude: async () => (up ? claudeOk(10) : { id: 'claude', status: 'unavailable', reason: 'x' }), codex: codexOk(10) });
    await e.start(); await e.first;
    up = false; advance(70); await e.tick(); await e.alerts!.settled();
    expect(b.notices).toEqual([]);
  });

  it('Refresh skips the backoff', async () => {
    const { b, e } = rig({ claude: { id: 'claude', status: 'unavailable', reason: 'x' }, codex: codexOk(10) });
    await e.start(); await e.first;
    const n = b.fetches.filter((x) => x === 'claude').length;
    await e.refreshNow();
    expect(b.fetches.filter((x) => x === 'claude').length).toBe(n + 1);
  });

  it('a failing notification is retried on a later check and the window counts only once delivered', async () => {
    let ok = false;
    const { b, e } = rig({ claude: claudeOk(97), codex: codexOk(10) }, { notify: () => ok });
    await e.start(); await e.first; await e.alerts!.settled();
    expect(e.alerts!.fired).toEqual([]);
    ok = true;
    await e.refreshNow(); await e.alerts!.settled();
    expect(e.alerts!.fired.length).toBe(2);
    expect(b.notices.length).toBe(2);
  });

  it('a storage error is shown, not thrown', async () => {
    const { b, e } = rig({ claude: claudeOk(40), codex: codexOk(10) });
    b.io.write = async () => { throw new Error('disk full'); };
    await e.start(); await e.first;
    await new Promise((r) => setTimeout(r, 10));
    expect(e.ioError).toMatch(/could not save/);
    expect(e.providers[0].limits.length).toBe(1);
  });
});

describe('tray text', () => {
  it('63% left in every state, nothing before data', async () => {
    const { e } = rig({ claude: claudeOk(37), codex: codexOk(10) });
    expect(trayText(e.providers)).toBe('');
    await e.start(); await e.first;
    expect(trayText(e.providers)).toBe('63% left');
    const { e: e2 } = rig({ claude: claudeOk(95), codex: codexOk(10) });
    await e2.start(); await e2.first;
    expect(trayText(e2.providers)).toBe('5% left');
    expect(trayTooltip(e2.providers, true)).toBe('Usage Bar: lowest 5% left (Claude Code, 5h limit), could not refresh just now');
  });
});
