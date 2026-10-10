// settings.json (the same file and key names as the Mac usage bar): strict decode, unknown keys kept (including __proto__).
import { DecodeError, Extra, dict, isObject, stripBom } from './json';

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export const LAYOUTS = ['cards', 'glass', 'solid', 'compact'] as const;
export const THEMES = ['classic', 'ocean', 'forest', 'grape', 'mono'] as const;
export const BLURS = ['off', 'light', 'medium', 'strong'] as const;
export type Appearance = (typeof APPEARANCES)[number];
export type Layout = (typeof LAYOUTS)[number];
export type ThemeName = (typeof THEMES)[number];
export type BlurStrength = (typeof BLURS)[number];

export const LIMIT_MIN = 3, LIMIT_MAX = 20, DEFAULT_USAGE_ROWS = 20;
export const ALERT_MIN = 50, ALERT_MAX = 99, DEFAULT_ALERT_LOW = 80, DEFAULT_ALERT_HIGH = 95;
export const GLASS_STEP = 5, DEFAULT_GLASS = 100;

export interface AppSettings {
  usageRows: number; alertsOn: boolean; alertLow: number; alertHigh: number; showHistory: boolean;
  appearance: Appearance; theme: ThemeName; layout: Layout; glass: number; blur: BlurStrength;
  /** Rust reads these two itself from settings.json. */
  useSystemProxy: boolean; codexPath: string;
}

export const defaultSettings = (): AppSettings => ({
  usageRows: DEFAULT_USAGE_ROWS, alertsOn: true, alertLow: DEFAULT_ALERT_LOW, alertHigh: DEFAULT_ALERT_HIGH, showHistory: true,
  appearance: 'system', theme: 'classic', layout: 'cards', glass: DEFAULT_GLASS, blur: 'medium', useSystemProxy: false, codexPath: '',
});

/** File key (the Mac names) for each setting. */
export const KEYS: Record<keyof AppSettings, string> = {
  usageRows: 'usage_rows', alertsOn: 'alerts_on', alertLow: 'alert_low', alertHigh: 'alert_high', showHistory: 'show_history',
  appearance: 'appearance', theme: 'theme', layout: 'layout', glass: 'glass', blur: 'blur', useSystemProxy: 'use_system_proxy', codexPath: 'codex_path',
};
const KNOWN = Object.values(KEYS);
const NAMES = Object.keys(KEYS) as Array<keyof AppSettings>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const whole = (n: number) => Math.trunc(n);

export const clampRows = (n: number): number => clamp(whole(n), LIMIT_MIN, LIMIT_MAX);
export const clampAlert = (n: number): number => clamp(whole(n), ALERT_MIN, ALERT_MAX);
export const snapGlass = (n: number): number => clamp(Math.round(n / GLASS_STEP) * GLASS_STEP, 0, 100);

export function validated(s: AppSettings): AppSettings {
  const d = defaultSettings();
  const num = (v: unknown, f: (n: number) => number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? f(v) : dflt);
  const choice = <T extends string>(v: unknown, opts: readonly T[], dflt: T): T => (typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T) : dflt);
  return {
    usageRows: num(s.usageRows, clampRows, d.usageRows), alertsOn: typeof s.alertsOn === 'boolean' ? s.alertsOn : d.alertsOn,
    alertLow: num(s.alertLow, clampAlert, d.alertLow), alertHigh: num(s.alertHigh, clampAlert, d.alertHigh),
    showHistory: typeof s.showHistory === 'boolean' ? s.showHistory : d.showHistory,
    appearance: choice(s.appearance, APPEARANCES, d.appearance), theme: choice(s.theme, THEMES, d.theme), layout: choice(s.layout, LAYOUTS, d.layout),
    glass: num(s.glass, snapGlass, d.glass), blur: choice(s.blur, BLURS, d.blur),
    useSystemProxy: typeof s.useSystemProxy === 'boolean' ? s.useSystemProxy : d.useSystemProxy,
    codexPath: typeof s.codexPath === 'string' && s.codexPath.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(s.codexPath) ? s.codexPath.trim() : d.codexPath,
  };
}

export interface ParsedSettings { settings: AppSettings; notes: string[]; extra: Extra }

/** One value at a time: a missing or unusable field falls back to its default. Throws DecodeError only when the text is not a JSON object. */
export function parseSettings(text: string): ParsedSettings {
  let root: unknown;
  try { root = JSON.parse(stripBom(text)); } catch (e) { throw new DecodeError(`settings.json is not valid JSON (${(e as Error).message})`); }
  if (!isObject(root)) throw new DecodeError('settings.json is not a JSON object');
  const notes: string[] = [];
  const raw = dict<unknown>();
  for (const n of NAMES) {
    const v = root[KEYS[n]];
    if (v !== undefined && v !== null) raw[n] = v;
  }
  const d = defaultSettings();
  const out: AppSettings = validated({ ...d, ...(raw as Partial<AppSettings>) });
  for (const n of NAMES) {
    if (raw[n] === undefined) continue;
    const same = JSON.stringify(out[n]) === JSON.stringify(raw[n]);
    const typeOk = typeof raw[n] === typeof d[n] && !(typeof raw[n] === 'number' && !Number.isFinite(raw[n]));
    if (!typeOk) notes.push(`ignored: ${KEYS[n]} has the wrong type`);
    else if (!same) { /* clamped or snapped, or an unknown choice already fell back */
      if (typeof raw[n] === 'string') notes.push(`ignored: ${KEYS[n]} is not one of the allowed values`);
    }
  }
  const extra: Extra = dict<unknown>();
  for (const k of Object.keys(root)) if (!KNOWN.includes(k)) extra[k] = root[k];
  return { settings: out, notes, extra };
}

/** What gets written: unknown keys first, then ours (file key names). */
export function settingsToObject(s: AppSettings, extra: Extra): Record<string, unknown> {
  const v = validated(s);
  const out: Record<string, unknown> = dict<unknown>();
  for (const k of Object.keys(extra)) out[k] = extra[k];
  for (const n of NAMES) out[KEYS[n]] = v[n];
  return out;
}

/** The file's values, with every setting that differs between `base` and `mine` taken from `mine`. */
export function mergeSettings(disk: AppSettings, mine: AppSettings, base: AppSettings): AppSettings {
  const r: AppSettings = { ...disk };
  for (const n of NAMES) if (mine[n] !== base[n]) (r as unknown as Record<string, unknown>)[n] = mine[n];
  return r;
}
