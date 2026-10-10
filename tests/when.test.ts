import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/when.json';
import countdownCases from './fixtures/countdown.json';
import { countdown, parseResetText, parseWhen, partsOf, resetLine, resetText, zonedToEpoch } from '../src/core/when';

const VAN = 'America/Vancouver';
const at = (y: number, mo: number, d: number, h: number, mi: number, tz = VAN) => zonedToEpoch(y, mo, d, h, mi, tz)!;

describe('parseWhen', () => {
  for (const c of fixtures.good) it(`reads ${JSON.stringify(c.in)}`, () => expect(parseWhen(c.in)).toBeCloseTo(c.want, 6));
  for (const g of fixtures.garbage) it(`rejects ${JSON.stringify(g)?.slice(0, 30)}`, () => expect(parseWhen(g as unknown)).toBeNull());
  it('NaN and Infinity are rejected', () => { expect(parseWhen(NaN)).toBeNull(); expect(parseWhen(Infinity)).toBeNull(); });
});

describe('countdown', () => {
  const n = 1_000_000;
  for (const c of countdownCases) it(`${c.left} s left reads ${c.want}`, () => expect(countdown(n + c.left, n)).toBe(c.want));
  it('bad input gives an empty string', () => {
    for (const bad of [null, NaN, Infinity, 'x', true, undefined]) expect(countdown(bad, 100)).toBe('');
    expect(countdown(100, NaN)).toBe('');
  });
  it('never negative, whatever the clock does', () => {
    for (let d = -100000; d < 100000; d += 977) expect(countdown(n + d, n)).not.toMatch(/-/);
  });
  it('reset line joins text and countdown', () => {
    expect(resetLine('resets 17:19', n + 7200, n)).toBe('Resets 17:19 · in 2 h');
    expect(resetLine('resets 17:19', n - 1, n)).toBe('Resets 17:19 · resetting');
    expect(resetLine('resets 17:19', null, n)).toBe('Resets 17:19');
    expect(resetLine('', n + 60, n)).toBe('');
  });
});

describe('zones, DST and reset text', () => {
  it('zonedToEpoch round-trips through partsOf', () => {
    const e = at(2026, 10, 7, 17, 19);
    expect(partsOf(e, VAN)).toMatchObject({ y: 2026, mo: 10, d: 7, h: 17, mi: 19 });
  });
  it('time only is the nearest occurrence', () => {
    expect(parseResetText('resets 17:19', at(2026, 10, 7, 15, 0), VAN)).toBe(at(2026, 10, 7, 17, 19));
    expect(parseResetText('resets 02:10', at(2026, 10, 7, 23, 50), VAN)).toBe(at(2026, 10, 8, 2, 10));
  });
  it('a reset that just passed stays in the past', () => {
    const now = at(2026, 10, 7, 17, 25);
    const r = parseResetText('resets 17:19', now, VAN)!;
    expect(r).toBeLessThan(now);
    expect(countdown(r, now)).toBe('resetting');
  });
  it('with a day, and across the year boundary', () => {
    expect(parseResetText('resets 09:00 on 9 Oct', at(2026, 10, 7, 15, 0), VAN)).toBe(at(2026, 10, 9, 9, 0));
    expect(parseResetText('resets 09:00 on 1 Nov', at(2026, 10, 7, 15, 0), VAN)).toBe(at(2026, 11, 1, 9, 0));
    expect(parseResetText('resets 08:00 on 2 Jan', at(2026, 12, 30, 12, 0, 'UTC'), 'UTC')).toBe(at(2027, 1, 2, 8, 0, 'UTC'));
  });
  // DST tests use Europe/Berlin: its rules are fixed by EU law since 1996. America/Vancouver is NOT used for these: tzdata 2026c
  // (Node 24.20 on the CI runners) already has British Columbia on permanent summer time from November 2026, so "fall back in Vancouver"
  // gives 11 h there and 12 h with older tzdata (Node 26 here). The code is right in both; the old test depended on the tz database version.
  const BER = 'Europe/Berlin';
  it('spring forward uses absolute time: 22:00 -> 09:00 is 10 h, not 11', () => {
    const now = at(2026, 3, 28, 22, 0, BER);
    expect(countdown(parseResetText('resets 09:00 on 29 Mar', now, BER), now)).toBe('in 10 h');
  });
  it('fall back: that night is 25 hours long, so 22:00 -> 09:00 is 12 h', () => {
    const now = at(2026, 10, 24, 22, 0, BER);
    expect(countdown(parseResetText('resets 09:00 on 25 Oct', now, BER), now)).toBe('in 12 h');
  });
  it('a time in the DST gap lands after the gap, not on a missing time', () => {
    const e = at(2026, 3, 29, 2, 30, BER);
    expect(partsOf(e, BER).h).toBe(3);
  });
  it('the same maths holds for a zone with no DST at all, whatever the database says', () => {
    const now = at(2026, 10, 31, 22, 0, 'Asia/Kolkata');
    expect(countdown(parseResetText('resets 09:00 on 1 Nov', now, 'Asia/Kolkata'), now)).toBe('in 11 h');
  });
  it('other zones: Kolkata (+5:30) and Auckland', () => {
    const now = at(2026, 10, 7, 12, 0, 'Asia/Kolkata');
    expect(countdown(parseResetText('resets 14:30', now, 'Asia/Kolkata'), now)).toBe('in 2 h 30 min');
    const n2 = at(2026, 9, 26, 12, 0, 'Pacific/Auckland');
    expect(countdown(parseResetText('resets 12:00 on 28 Sep', n2, 'Pacific/Auckland'), n2)).toBe('in 1 d 23 h'); // NZ DST starts on 27 Sep 2026
  });
  it('unparseable text', () => {
    for (const bad of ['', null, 'resets soon', 'resets 25:99', 'resets 09:00 on 40 Oct', 5, 'resets 09:00 on 31 Feb', 'resets 09:00 on 5 Xyz'])
      expect(parseResetText(bad, 1_000_000, VAN)).toBeNull();
  });
  it('resetText: today shows only the time, another day adds the date', () => {
    const now = at(2026, 10, 7, 15, 0);
    expect(resetText(at(2026, 10, 7, 17, 19), now, VAN)).toBe('resets 17:19');
    expect(resetText(at(2026, 10, 9, 19, 0), now, VAN)).toBe('resets 19:00 on 9 Oct');
    expect(resetText(null, now, VAN)).toBe('');
  });
});
