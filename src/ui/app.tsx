import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Engine } from './engine';
import * as I from './icons';
import { palette, statusColors, tintFor, lineColor, THEME_SWATCH, type Palette } from './palette';
import * as H from '../core/history';
import { Limit, Provider, ProviderView, layoutRows, stateOf, worstRemaining, Health } from '../core/model';
import { resetLine, resetText } from '../core/when';
import {
  ALERT_MAX, ALERT_MIN, AppSettings, APPEARANCES, BLURS, LAYOUTS, LIMIT_MAX, LIMIT_MIN, THEMES, ThemeName,
} from '../core/settings';

type View = 'main' | 'settings';
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const LAYOUT_LABEL: Record<AppSettings['layout'], string> = { cards: 'Cards', glass: 'Glass', solid: 'Solid', compact: 'Compact' };

export function useDark(appearance: AppSettings['appearance']): boolean {
  const mq = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const [sys, setSys] = useState(mq.matches);
  useEffect(() => { const f = () => setSys(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [mq]);
  return appearance === 'dark' || (appearance === 'system' && sys);
}

export function applyTheme(s: AppSettings, dark: boolean): Palette {
  const p = palette(dark, s.theme);
  const r = document.documentElement;
  r.dataset.theme = dark ? 'dark' : 'light';
  const set = (k: string, v: string) => r.style.setProperty(k, v);
  set('--panel', p.panel); set('--card', p.card); set('--text', p.text); set('--text2', p.text2); set('--line', p.line);
  set('--button', p.button); set('--field', p.field); set('--field-border', p.fieldBorder); set('--track', p.track); set('--accent', p.accent); set('--focus', p.focus);
  // Glass: how see-through the cards are. Solid is always opaque. The blur is a CSS blur of what is behind the card inside this
  // window only (a webview cannot see the desktop), so it is mild; it exists so the settings file means the same on every OS.
  const glass = s.layout === 'glass';
  set('--card-alpha', glass ? String(Math.max(0.55, 1 - (s.glass / 100) * 0.45)) : '1');
  set('--blur', glass ? ({ off: '0px', light: '3px', medium: '6px', strong: '12px' })[s.blur] : '0px');
  return p;
}

export function App({ engine }: { engine: Engine }) {
  const [, setTick] = useState(0);
  useEffect(() => engine.subscribe(() => setTick((x) => x + 1)), [engine]);
  const s = engine.s;
  const dark = useDark(s.appearance);
  const pal = applyTheme(s, dark);
  const [view, setView] = useState<View>('main');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (view === 'settings') titleRef.current?.focus(); else settingsBtn.current?.focus();
  }, [view]);
  // the Refresh button comes back after its 10 s cooldown
  const cool = engine.cooldownLeft();
  useEffect(() => {
    if (cool <= 0) return;
    const t = setTimeout(() => setTick((x) => x + 1), cool * 1000 + 50);
    return () => clearTimeout(t);
  }, [cool]);
  useEffect(() => engine.backend.onShown(() => { setView('main'); titleRef.current?.focus(); }), [engine]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (view === 'settings') setView('main'); else void engine.backend.hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, engine]);

  const now = engine.nowSec();
  const worst = worstRemaining(engine.providers);
  const loading = engine.loading.size > 0 && engine.updated === null && engine.providers.every((p) => engine.loading.has(p.id));
  const stale = engine.stale.size > 0;
  const updated = engine.updated === null ? '' : new Date(engine.updated * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const subtitle = updated ? `Updated ${updated}${stale ? " · couldn't refresh" : ''}` : loading ? 'Loading…' : stale ? "Couldn't refresh" : 'Waiting for the first refresh';
  const worstHealth = stateOf(worst);

  return (
    <div class={`app ${s.layout}`}>
      <header class="head">
        <div>
          <h1 tabIndex={-1} ref={titleRef}>{view === 'settings' ? 'Settings' : 'Usage'}</h1>
          <p class="sub" role="status" aria-live="polite">{view === 'settings' ? 'Saved in settings.json' : subtitle}</p>
        </div>
        {view === 'main' && worst !== null && (
          <p class="stats" aria-label={`Lowest limit ${worst} percent left`}>Lowest <b style={{ color: statusColors(worstHealth, dark, s.theme, pal.panel).text }}>{worst}% left</b></p>
        )}
      </header>
      <main class="scroll">
        {view === 'settings' ? <SettingsPane engine={engine} dark={dark} /> : <MainView engine={engine} dark={dark} pal={pal} now={now} />}
      </main>
      <footer class="foot">
        {view === 'settings'
          ? <button class="ghost" onClick={() => setView('main')}><I.Back /> Back</button>
          : <button class="ghost" disabled={engine.cooldownLeft() > 0} onClick={() => void engine.refreshNow()}><I.Refresh /> {engine.cooldownLeft() > 0 ? 'Updated just now' : 'Refresh'}</button>}
        {view === 'main' && <button class="ghost" ref={settingsBtn} onClick={() => setView('settings')}><I.Gear /> Settings</button>}
        <span class="grow" style={{ flex: 1 }} />
        <button class="ghost" onClick={() => void engine.backend.quit()}><I.Power /> Quit</button>
      </footer>
    </div>
  );
}

function MainView({ engine, dark, pal, now }: { engine: Engine; dark: boolean; pal: Palette; now: number }) {
  const s = engine.s;
  const views = layoutRows(engine.providers, s.usageRows);
  const nothing = engine.providers.every((p) => !p.installed);
  return (
    <>
      {nothing && (
        <div class="empty" role="note">
          <h2>No Claude Code or Codex found</h2>
          <p>Install and sign in to either tool, then press Refresh.</p>
        </div>
      )}
      {views.map((v) => <ProviderSection key={v.provider.id} v={v} engine={engine} dark={dark} pal={pal} now={now} />)}
      {engine.settings.loadError && <p class="msg" role="alert">{engine.settings.loadError}</p>}
    </>
  );
}

function ProviderSection({ v, engine, dark, pal, now }: { v: ProviderView; engine: Engine; dark: boolean; pal: Palette; now: number }) {
  const s = engine.s;
  const p = v.provider;
  const tint = tintFor(p.name, dark, s.theme, pal.card);
  const loading = engine.loading.has(p.id);
  const stale = engine.stale.has(p.id);
  const lines: Array<[string, Array<[number, number]>]> = [];
  if (s.showHistory && engine.history) {
    for (const l of v.shown) {
      const smp = engine.history.samples(p.name, l.label);
      if (H.hasHistory(smp, now)) lines.push([l.label, smp]);
    }
  }
  const notes = loading ? [engine.waiting(p.id) ? 'Waiting to retry after an earlier failure' : 'Loading…'] : v.notes;
  return (
    <section aria-label={p.name}>
      <h2 class="phead">
        <span class="dot" aria-hidden="true" style={{ background: dotColor(p, loading, stale, dark, s.theme, pal) }} />
        <span>{p.name}</span>
        {(p.tier || p.account) && <span class="tier">{[p.account, p.tier].filter(Boolean).join(' · ')}</span>}
      </h2>
      {v.shown.length > 0 && (
        <ul class="cards">
          {v.shown.map((l) => <li key={l.label}><LimitCard l={l} provider={p} tint={tint} dark={dark} pal={pal} now={now} layout={s.layout} theme={s.theme} /></li>)}
        </ul>
      )}
      {lines.length > 0 && <HistoryRow provider={p} lines={lines} now={now} color={lineColor(tint.base, pal.card)} />}
      {v.hiddenNote && <p class="note">{v.hiddenNote}</p>}
      {notes.map((n) => <p key={n} class={`note${n.startsWith('usage unavailable') || n.startsWith('Sign in') || n === 'Not signed in' ? ' err' : ''}`}>{n}</p>)}
      {stale && v.shown.length > 0 && <p class="note err">Couldn't refresh: showing the last numbers.</p>}
      {p.installed && v.shown.length > 0 && (
        <button class="ghost action" onClick={() => void engine.backend.openUsagePage(p.id)}>Use a usage reset… <I.Out /></button>
      )}
    </section>
  );
}

function dotColor(p: Provider, loading: boolean, stale: boolean, dark: boolean, theme: ThemeName, pal: Palette): string {
  if (loading || !p.installed || p.status === 'not_signed_in') return pal.text2;
  if (p.limits.length === 0 || stale) return statusColors('critical', dark, theme, pal.panel).base;
  return statusColors('healthy', dark, theme, pal.panel).base;
}

function LimitCard({ l, provider, tint, dark, pal, now, layout, theme }: { l: Limit; provider: Provider; tint: ReturnType<typeof tintFor>; dark: boolean; pal: Palette; now: number; layout: AppSettings['layout']; theme: ThemeName }) {
  const health: Health = stateOf(l.remaining);
  const st = statusColors(health, dark, theme, pal.card);
  const arc = lineColor(st.base, pal.card);
  const sub = [`${l.remaining}% left`, resetLine(resetText(l.resetAt, now), l.resetAt, now)].filter(Boolean).join(' · ');
  const label = `${provider.name}, ${l.label}, ${l.remaining} percent left${health === 'critical' ? ', critical' : ''}${l.resetAt ? `, ${resetLine(resetText(l.resetAt, now), l.resetAt, now)}` : ''}`;
  const chip = (
    <span class="pill" style={{ background: st.chipBg, color: st.chipText, '--card': st.chipBg } as never}>
      {health === 'healthy' ? <I.Ok /> : <I.Warn />}{health === 'critical' ? 'Critical' : health === 'warning' ? 'Low' : 'OK'}
    </span>
  );
  if (layout === 'solid' || layout === 'compact') {
    return (
      <div class="card" role="group" aria-label={label}>
        <div class="limit"><div style={{ width: '100%' }}>
          <div class="l2"><h3>{l.label}</h3><b style={{ color: st.text }}>{l.remaining}% left</b></div>
          <div class="bar" aria-hidden="true"><i style={{ width: `${Math.max(l.remaining > 0 ? 3 : 0, l.remaining)}%`, background: arc }} /></div>
          {l.resetAt !== null && <p class="lsub">{resetLine(resetText(l.resetAt, now), l.resetAt, now)}</p>}
        </div></div>
      </div>
    );
  }
  const R = 22, C = 2 * Math.PI * R;
  return (
    <div class="card" role="group" aria-label={label}>
      <div class="limit">
        <div class="ring" role="img" aria-label={`${l.remaining} percent left`}>
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <circle cx="28" cy="28" r={R} fill="none" stroke={arc} stroke-opacity="0.22" stroke-width="5.5" />
            <circle cx="28" cy="28" r={R} fill="none" stroke={arc} stroke-width="5.5" stroke-linecap="round" stroke-dasharray={`${(C * l.remaining) / 100} ${C}`} />
          </svg>
          <b aria-hidden="true">{l.remaining}%</b>
        </div>
        <div class="lmain">
          <div class="row1">
            <span class="pill" style={{ background: tint.chipBg, color: tint.chipText }}>{provider.name}</span>
            {chip}
          </div>
          <h3>{l.label}</h3>
          <p class="lsub">{sub}</p>
        </div>
      </div>
    </div>
  );
}

function HistoryRow({ provider, lines, now, color }: { provider: Provider; lines: Array<[string, Array<[number, number]>]>; now: number; color: string }) {
  const W = 200, Hh = 24;
  const alphas = [1, 0.6, 0.4, 0.3];
  let pk = 0;
  return (
    <div class="hist" role="img" aria-label={H.describe(provider.name, lines, now)}>
      <span class="lab" aria-hidden="true">7 days</span>
      <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={Hh - 0.25} x2={W} y2={Hh - 0.25} stroke="currentColor" stroke-opacity="0.2" stroke-width="1" vector-effect="non-scaling-stroke" />
        {lines.map(([label, smp], i) => {
          pk = Math.max(pk, H.peak(smp, now));
          return H.plotSegments(smp, now, W, Hh - 1).map((seg, j) => seg.length === 1
            ? <circle key={`${label}${j}`} cx={seg[0][0]} cy={seg[0][1]} r="1.4" fill={color} fill-opacity={alphas[Math.min(i, 3)]} />
            : <polyline key={`${label}${j}`} points={seg.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ')} fill="none" stroke={color} stroke-opacity={alphas[Math.min(i, 3)]} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />);
        })}
      </svg>
      <span class="peak" aria-hidden="true">peak {Math.trunc(pk)}%</span>
    </div>
  );
}

// ---- settings ----------------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return <div class="srow"><span>{label}</span>{children}</div>;
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <Row label={label}>
      <span class="stepper" role="group" aria-label={label}>
        <button class="round" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><I.Minus /></button>
        <output aria-live="polite">{value}</output>
        <button class="round" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><I.Plus /></button>
      </span>
    </Row>
  );
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (b: boolean) => void }) {
  return <Row label={label}><button class="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} /></Row>;
}

function Seg<T extends string>({ name, label, value, options, onChange }: { name: string; label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <fieldset class="seg" style={{ border: 0, margin: 0 }} aria-label={label}>
      {options.map((o) => (
        <label key={o}><input type="radio" name={name} checked={value === o} onChange={() => onChange(o)} />{LAYOUT_LABEL[o as keyof typeof LAYOUT_LABEL] ?? cap(o)}</label>
      ))}
    </fieldset>
  );
}

function SettingsPane({ engine, dark }: { engine: Engine; dark: boolean }) {
  const s = engine.s;
  const up = (p: Partial<AppSettings>) => void engine.update(p);
  const st = engine.settings;
  void dark;
  return (
    <div class="set">
      <section>
        <h2>Limits and alerts</h2>
        <Stepper label="Limit rows shown" value={s.usageRows} min={LIMIT_MIN} max={LIMIT_MAX} onChange={(n) => up({ usageRows: n })} />
        <Switch label="Usage alerts" on={s.alertsOn} onChange={(b) => up({ alertsOn: b })} />
        <Stepper label="First alert at % used" value={s.alertLow} min={ALERT_MIN} max={ALERT_MAX} onChange={(n) => up({ alertLow: n })} />
        <Stepper label="Second alert at % used" value={s.alertHigh} min={ALERT_MIN} max={ALERT_MAX} onChange={(n) => up({ alertHigh: n })} />
        <Switch label="Show 7-day history" on={s.showHistory} onChange={(b) => up({ showHistory: b })} />
        {engine.backend.autostart && <Switch label="Start at login" on={engine.autostart === true} onChange={(b) => void engine.setAutostart(b)} />}
      </section>
      <section><h2>Appearance</h2><Seg name="appearance" label="Appearance" value={s.appearance} options={APPEARANCES} onChange={(v) => up({ appearance: v })} /></section>
      <section>
        <h2>Colour theme</h2>
        <fieldset class="themes" style={{ border: 0, margin: 0, padding: 0 }} aria-label="Colour theme">
          {THEMES.map((t) => (
            <label key={t}>
              <input type="radio" name="theme" checked={s.theme === t} onChange={() => up({ theme: t })} />
              <span class="sw" style={{ background: THEME_SWATCH[t] }}>{s.theme === t && <I.Ok />}</span>{cap(t)}
            </label>
          ))}
        </fieldset>
      </section>
      <section><h2>Layout</h2><Seg name="layout" label="Layout" value={s.layout} options={LAYOUTS} onChange={(v) => up({ layout: v })} /></section>
      {s.layout === 'glass' && (
        <>
          <section>
            <h2>Glass amount</h2>
            <input class="range" type="range" min="0" max="100" step="5" value={s.glass} aria-label="Glass amount" onInput={(e) => up({ glass: Number((e.target as HTMLInputElement).value) })} />
            <p class="help">{s.glass}% · Glass makes the cards see-through. Solid is always opaque. A tray window cannot blur your desktop, so the blur only softens what is inside this window.</p>
          </section>
          <section><h2>Blur strength</h2><Seg name="blur" label="Blur strength" value={s.blur} options={BLURS} onChange={(v) => up({ blur: v })} /></section>
        </>
      )}
      <div class="srow">
        <button class="btn" onClick={() => void engine.reset()}>Reset to defaults</button>
        <span class="help">Saved in settings.json</span>
      </div>
      <section>
        <h2>Network and codex</h2>
        <Switch label="Use system proxy settings" on={s.useSystemProxy} onChange={(b) => up({ useSystemProxy: b })} />
        <p class="help">Off by default: HTTPS_PROXY and similar variables are ignored, so your sign-in token only ever goes straight to Anthropic or OpenAI. Turn on only if your network needs a proxy you trust.</p>
        <label class="srow"><span>Path to codex</span>
          <input class="field" type="text" aria-label="Path to codex" placeholder="found automatically" value={s.codexPath} spellcheck={false}
            onChange={(e) => up({ codexPath: (e.target as HTMLInputElement).value })} />
        </label>
        <p class="help">Only needed when the app cannot find the codex program (a login item has a short PATH). Absolute path to an executable file.</p>
      </section>
      {st.saveError && <p class="msg" role="alert">Could not save: {st.saveError}</p>}
      {engine.ioError && <p class="msg" role="alert">{engine.ioError}</p>}
      {st.ignoredNotes.length > 0 && <p class="msg">{st.ignoredNotes.join('. ')}.</p>}
      {engine.backend.trayNote && <p class="help">{engine.backend.trayNote}</p>}
      <p class="help">Data folder: {engine.backend.dataDir}</p>
    </div>
  );
}
