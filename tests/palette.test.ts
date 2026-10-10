import { describe, expect, it } from 'vitest';
import { Contrast } from '../src/ui/contrast';
import { lineColor, palette, statusColors, tintFor } from '../src/ui/palette';
import { THEMES } from '../src/core/settings';

const r = (a: string, b: string) => Contrast.ratioHex(a, b);

describe('every text colour reaches 4.5:1 on what it is drawn on (all themes, light and dark)', () => {
  for (const theme of THEMES) for (const dark of [false, true]) {
    it(`${theme} ${dark ? 'dark' : 'light'}`, () => {
      const p = palette(dark, theme);
      for (const bg of [p.panel, p.card]) { expect(r(p.text, bg)).toBeGreaterThanOrEqual(4.5); expect(r(p.text2, bg)).toBeGreaterThanOrEqual(4.5); }
      expect(r(p.text, p.button)).toBeGreaterThanOrEqual(4.5);
      expect(r(p.text, p.field)).toBeGreaterThanOrEqual(4.5);
      expect(r(p.fieldBorder, p.field)).toBeGreaterThanOrEqual(3);
      for (const h of ['healthy', 'warning', 'critical'] as const) {
        const s = statusColors(h, dark, theme, p.card);
        expect(r(s.text, p.card), `${h} text`).toBeGreaterThanOrEqual(4.5);
        expect(r(s.chipText, s.chipBg), `${h} chip`).toBeGreaterThanOrEqual(4.5);
        expect(r(lineColor(s.base, p.card), p.card), `${h} ring`).toBeGreaterThanOrEqual(3);
        expect(r(s.text, p.panel), `${h} text on panel (header)`).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ['Claude Code', 'Codex CLI', 'Some Other Tool']) {
        const t = tintFor(name, dark, theme, p.card);
        expect(r(t.text, p.card)).toBeGreaterThanOrEqual(4.5);
        expect(r(t.chipText, t.chipBg)).toBeGreaterThanOrEqual(4.5);
        expect(r(lineColor(t.base, p.card), p.card)).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it('the provider tints are the Mac ones: Claude blue, Codex pink in Classic', () => {
    expect(tintFor('Claude Code', false, 'classic', '#e3e3e3').base).toBe('#2F7BF5');
    expect(tintFor('Codex CLI', false, 'classic', '#e3e3e3').base).toBe('#E0508A');
  });
});
