// Colours for panel, cards, text, status chips and the provider tints. Every text colour is worked out against the exact
// background it is drawn on and reaches 4.5:1 (checked for every theme, light and dark, in tests/palette.test.ts).
import { Contrast, lighten, rgbOf } from './contrast';
import type { Health } from '../core/model';
import type { ThemeName } from '../core/settings';

interface ThemeBase { accent: string; tints: string[]; success: [string, string]; warning: [string, string]; danger: [string, string] }

const BASE: Record<ThemeName, ThemeBase> = {
  classic: { accent: '#2F7BF5', tints: ['#2F7BF5', '#F5871F', '#8E5BD9', '#17A2A2', '#E0508A', '#2DA44E'], success: ['#34C759', '#30D158'], warning: ['#FF9500', '#FF9F0A'], danger: ['#FF3B30', '#FF453A'] },
  ocean: { accent: '#0A84A8', tints: ['#0A84A8', '#2C6BD6', '#12A58B', '#4B8BBE', '#5F6FD8', '#3AA6D8'], success: ['#008C82', '#4DD0C3'], warning: ['#B06400', '#FFBE50'], danger: ['#CD3E3A', '#FF786E'] },
  forest: { accent: '#2E8B57', tints: ['#2E8B57', '#8A9A2B', '#B5651D', '#4F7F3A', '#1F7A6B', '#9C7A3C'], success: ['#00796B', '#26C6A8'], warning: ['#B46400', '#FFB74D'], danger: ['#BF360C', '#FF8A65'] },
  grape: { accent: '#8E44C8', tints: ['#8E44C8', '#C2449B', '#5B5BD6', '#B14FD6', '#D6457A', '#6E56CF'], success: ['#00897B', '#4DB6AC'], warning: ['#B06400', '#FFBE5A'], danger: ['#C2185B', '#F46EA0'] },
  mono: { accent: '#5A6270', tints: ['#5A6270', '#7B8494', '#46505F', '#8A93A3', '#667082', '#394150'], success: ['#5A5A60', '#BEBEC6'], warning: ['#46464C', '#D7D7E1'], danger: ['#141414', '#FFFFFF'] },
};

export interface Palette {
  panel: string; card: string; text: string; text2: string; line: string; field: string; fieldBorder: string; button: string; track: string;
  accent: string; focus: string;
}

const g = (v: number) => Contrast.hex([v, v, v]);

export function palette(dark: boolean, theme: ThemeName): Palette {
  const panel = dark ? '#2B2B2B' : '#F2F2F2';
  const card = Contrast.hex(Contrast.mix(dark ? [1, 1, 1] : [0, 0, 0], Contrast.rgb(panel)!, 0.06));
  const accent = dark ? lighten(BASE[theme].accent, 0.28) : BASE[theme].accent;
  return {
    panel, card,
    text: dark ? g(0.95) : g(0.08),
    text2: dark ? '#BDBDBD' : '#595959',
    line: dark ? '#5A5A5A' : '#B8B8B8',
    field: dark ? '#1A1A1A' : '#FFFFFF',
    fieldBorder: dark ? '#7A7A7A' : '#8A8A8A',
    button: dark ? '#444444' : '#D0D0D0',
    track: dark ? '#4A4A4A' : '#CFCFCF',
    accent, focus: dark ? '#7DB2FF' : '#0A5BD8',
  };
}

/** The colour of a status on the card, readable as text; `base` is the ring / chip colour. */
export function statusColors(health: Health, dark: boolean, theme: ThemeName, card: string): { base: string; text: string; chipBg: string; chipText: string } {
  const b = BASE[theme];
  const pair = health === 'critical' ? b.danger : health === 'warning' ? b.warning : b.success;
  const base = dark ? pair[1] : pair[0];
  const cardRgb = Contrast.rgb(card)!;
  const chipBgHex = Contrast.hex(Contrast.mix(Contrast.rgb(base)!, cardRgb, 0.16));
  return {
    base,
    text: Contrast.readableHex(base, card, 4.5),
    chipBg: chipBgHex,
    chipText: Contrast.readableHex(base, chipBgHex, 4.5),
  };
}

/** A stable tint per provider name (the same djb2 pick as the Mac app) and its readable text colour. */
export function tintFor(name: string, dark: boolean, theme: ThemeName, card: string): { base: string; text: string; chipBg: string; chipText: string } {
  const list = BASE[theme].tints;
  let h = 5381n;
  for (const ch of name) h = (h * 33n + BigInt(ch.codePointAt(0)!)) & 0xffffffffffffffffn;
  const raw = list[Number(h % BigInt(list.length))];
  const base = dark ? lighten(raw, 0.28) : raw;
  const chipBg = Contrast.hex(Contrast.mix(Contrast.rgb(base)!, Contrast.rgb(card)!, 0.18));
  return { base, text: Contrast.readableHex(base, card, 4.5), chipBg, chipText: Contrast.readableHex(base, chipBg, 4.5) };
}

/** A colour for a thin line (ring arc, sparkline) that must stay visible (3:1) on the card. */
export function lineColor(hex: string, card: string): string { return Contrast.readableHex(hex, card, 3); }

export const THEME_SWATCH: Record<ThemeName, string> = Object.fromEntries((Object.keys(BASE) as ThemeName[]).map((t) => [t, `linear-gradient(135deg, ${BASE[t].tints[0]}, ${BASE[t].tints[1]})`])) as Record<ThemeName, string>;
export { rgbOf };
