import { describe, expect, it } from 'vitest';
import claude from './fixtures/claude-responses.json';
import codex from './fixtures/codex-responses.json';
import { parseClaudeUsage, parseCodexUsage, providerFromFetch } from '../src/core/parse';
import { remainingFromUsed } from '../src/core/model';

const NOW = 1_800_000_000;
const view = (p: { limits: Array<{ label: string; remaining: number }> }) => p.limits.map((l) => [l.label, l.remaining]);

describe('the left maths', () => {
  it('0.5 used reads 99 left; 100 left only when nothing is used', () => {
    expect(remainingFromUsed(0.5)).toBe(99);
    expect(remainingFromUsed(0)).toBe(100);
    expect(remainingFromUsed(0.0001)).toBe(99);
    expect(remainingFromUsed(100)).toBe(0);
    expect(remainingFromUsed(22)).toBe(78);
    expect(remainingFromUsed(37.5)).toBe(62);
  });
  it('over 100 and negative values clamp', () => {
    expect(remainingFromUsed(140)).toBe(0);
    expect(remainingFromUsed(-3)).toBe(100);
  });
  it('never 100 left unless used is exactly 0', () => {
    for (let u = 0.001; u < 1; u += 0.037) expect(remainingFromUsed(u)).toBeLessThan(100);
  });
});

describe('Claude responses', () => {
  it('a normal response gives labelled limits in order', () => {
    const p = parseClaudeUsage(claude.normal, NOW);
    expect(view(p)).toEqual([['5h limit', 78], ['Weekly limit', 25], ['Weekly Opus', 99], ['Weekly Sonnet', 100], ['Extra usage', 97]]);
    expect(p.limits[0].resetAt).toBeCloseTo(Date.UTC(2026, 9, 7, 17, 19) / 1000 + 0.123456, 5);
    expect(p.limits[2].resetAt).toBe(1900000000);
    expect(p.limits[3].resetAt).toBeNull();
    expect(p.unreadable).toBe(0);
  });
  it('tolerates strings, over 100, negatives, booleans, unknown windows and a disabled extra', () => {
    const p = parseClaudeUsage(claude.weird, NOW);
    expect(view(p)).toEqual([['5h limit', 62], ['Weekly limit', 0], ['Weekly Opus', 100], ['Future Window', 90]]);
    expect(p.limits[0].resetAt).toBe(1900000000);
    expect(p.limits[1].resetAt).toBeNull(); // 'garbage'
    expect(p.unreadable).toBe(2); // true and "abc"
  });
  it('empty, all-null and non-objects give no limits', () => {
    for (const r of [claude.empty, claude.allNull, claude.notAnObject, null, 5, 'x', undefined]) expect(parseClaudeUsage(r, NOW).limits).toEqual([]);
  });
  it('empty / all-null response marks the provider unavailable', () => {
    for (const raw of [claude.empty, claude.allNull]) {
      const p = providerFromFetch({ id: 'claude', status: 'ok', raw }, NOW);
      expect(p.status).toBe('unavailable');
      expect(p.notes[0]).toMatch(/^usage unavailable/);
    }
  });
});

describe('Codex responses', () => {
  it('web shape: windows named by length, plan, extra metered limits grouped', () => {
    const p = parseCodexUsage(codex.web, NOW);
    expect(view(p)).toEqual([['5h limit', 88], ['Weekly limit', 99], ['Spark 5h', 100], ['Spark Weekly', 0]]);
    expect(p.tier).toBe('Plus plan');
    expect(p.limits[0].resetAt).toBe(1900000000);
  });
  it('app-server shape', () => {
    const p = parseCodexUsage(codex.appServer, NOW);
    expect(view(p)).toEqual([['5h limit', 88]]);
    expect(p.tier).toBe('Plus plan');
    expect(p.limits[0].resetAt).toBe(1900000000);
  });
  it('reset_after_seconds is relative to the fetch time', () => {
    expect(parseCodexUsage(codex.afterOnly, NOW).limits[0].resetAt).toBe(NOW + 600);
  });
  it('empty, bad values', () => {
    expect(parseCodexUsage(codex.empty, NOW).limits).toEqual([]);
    const b = parseCodexUsage(codex.badValues, NOW);
    expect(b.limits).toEqual([]);
    expect(b.unreadable).toBe(1);
    expect(providerFromFetch({ id: 'codex', status: 'ok', raw: codex.empty }, NOW).notes[0]).toBe('usage unavailable (empty response)');
  });
});

describe('provider states', () => {
  it('not installed, not signed in, expired, unavailable', () => {
    expect(providerFromFetch({ id: 'codex', status: 'not_installed' }, NOW).installed).toBe(false);
    expect(providerFromFetch({ id: 'claude', status: 'not_signed_in' }, NOW).notes).toEqual(['Not signed in']);
    expect(providerFromFetch({ id: 'claude', status: 'expired' }, NOW).notes).toEqual(['Sign in again in Claude Code']);
    expect(providerFromFetch({ id: 'codex', status: 'expired' }, NOW).notes).toEqual(['Sign in again in Codex']);
    expect(providerFromFetch({ id: 'claude', status: 'unavailable', reason: 'timeout' }, NOW).notes).toEqual(['usage unavailable (timeout)']);
  });
  it('a reason that looks like a token is scrubbed', () => {
    const p = providerFromFetch({ id: 'claude', status: 'unavailable', reason: 'bad Bearer sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }, NOW);
    expect(p.notes[0]).not.toMatch(/ABCDEFGH/);
  });
  it('plan from credentials becomes the tier for Claude', () => {
    expect(providerFromFetch({ id: 'claude', status: 'ok', plan: 'max', raw: claude.normal }, NOW).tier).toBe('Max plan');
  });
  it('malformed shapes never throw', () => {
    for (const raw of [undefined, null, 5, 'x', [], [[]], { five_hour: 5 }, { five_hour: { utilization: {} } }, { rate_limit: 5 }, { rateLimits: [] }, { additional_rate_limits: 'x' }, { additional_rate_limits: [null, 5, {}] }]) {
      expect(() => providerFromFetch({ id: 'claude', status: 'ok', raw }, NOW)).not.toThrow();
      expect(() => providerFromFetch({ id: 'codex', status: 'ok', raw }, NOW)).not.toThrow();
    }
  });
});
