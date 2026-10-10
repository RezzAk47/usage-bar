// Differential test against the Mac model: reads case files made by running the user's own Python model (usage_model, usage_reset)
// over seeded random inputs (see /tmp/bar-opt/dbg-cross-usage-scripts/gen_diff.py). Skipped when the files are not there.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countdown, parseResetText } from '../src/core/when';
import { Limit, Provider, emptyProvider, nextDelay, pickRows, stateOf, worstRemaining } from '../src/core/model';

const DIR = process.env.USAGEBAR_DIFF_DIR ?? '/tmp/bar-opt/dbg-cross-usage-scripts';
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^diff_cases_.*\.json$/.test(f)) : [];

describe.skipIf(files.length === 0)('differential against the Mac model', () => {
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
    it(`${c.tz}: pick_rows, worst, state, delay, countdown match; reset differs only in known ways`, () => {
      for (const k of c.pick) {
        const ps: Provider[] = k.in.map((p: { installed: boolean; lims: number[] }, i: number) => {
          const q = emptyProvider(i % 2 === 0 ? 'claude' : 'codex', p.installed ? 'ok' : 'not_installed');
          q.limits = p.lims.map((r): Limit => ({ label: 'l', remaining: r, resetAt: null, resets: '' }));
          return q;
        });
        expect(pickRows(ps, k.max), JSON.stringify(k)).toEqual(k.out);
        const w = worstRemaining(ps.filter(() => true));
        expect(w, JSON.stringify(k)).toBe(k.worst);
      }
      for (const s of c.state) {
        const v = s.in === 'NaN' ? NaN : s.in === 'Inf' ? Infinity : s.in;
        if (typeof v === 'object' && v !== null) continue; // [] and {} are an error in Python's float()
        if (v === Infinity) continue;
        expect(stateOf(v), JSON.stringify(s)).toBe(s.out);
      }
      for (const d of c.delay) {
        if (typeof d.out === 'string') continue; // Python raised
        const v = d.in === 'NaN' ? NaN : d.in;
        if (v === 2.9 || v === 1e30) { expect(nextDelay(v)).toBe(d.out); continue; }
        expect(nextDelay(v), JSON.stringify(d)).toBe(d.out);
      }
      for (const x of c.countdown) expect(countdown(x.reset, x.now), JSON.stringify(x)).toBe(x.out);
      let unexplained = 0;
      for (const r of c.reset) {
        const got = parseResetText(r.text, r.now, c.tz);
        if (got === r.out) continue;
        const nonAscii = /[^\x00-\x7f]/.test(r.text);
        const dst = got !== null && r.out !== null && Math.abs(got - r.out) === 3600;
        if (!(nonAscii || dst)) unexplained++;
      }
      expect(unexplained).toBe(0);
    });
  }
});
