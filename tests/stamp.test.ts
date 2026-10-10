// A file stamp travels Rust -> JSON -> page -> JSON -> Rust and is compared for exact equality. It must survive that bit for bit.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FileStamp, sameStamp } from '../src/core/io';
import { bumpMtime, statOf, tmpDir } from './helpers';

describe('file stamps are exact integers', () => {
  it('10,000 realistic stamps survive JSON.parse(JSON.stringify()) and compare equal', () => {
    let x = 0x2545f491n;
    const rnd = () => { x ^= x << 13n; x &= 0xffffffffffffffffn; x ^= x >> 7n; x ^= x << 17n; x &= 0xffffffffffffffffn; return x; };
    for (let i = 0; i < 10_000; i++) {
      // nanosecond file times between 2001 and 2100, reduced to whole microseconds like the Rust side does
      const ns = 1_000_000_000_000_000_000n + (rnd() % 3_000_000_000_000_000_000n);
      const stamp: FileStamp = { size: Number(rnd() % 1_000_000_000n), mtimeUs: Number(ns / 1000n), ctimeUs: Number((ns + (rnd() % 5_000_000n)) / 1000n), ino: (rnd() % (1n << 60n)).toString() };
      expect(Number.isSafeInteger(stamp.mtimeUs) && Number.isSafeInteger(stamp.ctimeUs!)).toBe(true);
      const back = JSON.parse(JSON.stringify(stamp)) as FileStamp;
      expect(back).toEqual(stamp);
      expect(sameStamp(back, stamp)).toBe(true);
    }
  });
  it('the comparison is exact: one microsecond, one byte or another inode differs', () => {
    const a: FileStamp = { size: 10, mtimeUs: 1_760_000_000_123_456, ctimeUs: 1_760_000_000_123_457, ino: '42' };
    expect(sameStamp(a, { ...a })).toBe(true);
    expect(sameStamp(a, { ...a, mtimeUs: a.mtimeUs + 1 })).toBe(false);
    expect(sameStamp(a, { ...a, ctimeUs: a.ctimeUs! + 1 })).toBe(false);
    expect(sameStamp(a, { ...a, size: 11 })).toBe(false);
    expect(sameStamp(a, { ...a, ino: '43' })).toBe(false);
    expect(sameStamp(a, null)).toBe(false);
    expect(sameStamp(null, null)).toBe(true);
  });
  it('a real file stat is made of integers and survives JSON', () => {
    const dir = tmpDir(); const f = `${dir}/t.json`;
    fs.writeFileSync(f, 'x'); bumpMtime(f, 3);
    const s = statOf(f)!;
    for (const v of [s.size, s.mtimeUs, s.ctimeUs!]) expect(Number.isSafeInteger(v)).toBe(true);
    expect(sameStamp(JSON.parse(JSON.stringify(s)), s)).toBe(true);
  });
});
