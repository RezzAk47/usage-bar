import { render } from 'preact';
import { App, applyTheme } from './ui/app';
import { Engine } from './ui/engine';
import type { Backend } from './backend/types';
import { memoryBackend } from './backend/memory';
import { defaultSettings } from './core/settings';
import { PREVIEW_NOW, fixtureHistory, fixtureResponses } from './preview';

async function pickBackend(): Promise<Backend> {
  const inTauri = typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  if (inTauri) return (await import('./backend/tauri')).tauriBackend();
  // Browser preview: made-up data, never a real file. ?fixture=critical|normal|errors|notsigned|empty|emptyresp|crash
  // &history=1 adds a week of history; &settings={json}; &rtl=1 mirrors the page.
  const q = new URLSearchParams(location.search);
  const fixture = q.get('fixture') ?? 'critical';
  if (fixture === 'crash') throw new Error('test: the page failed to start');
  if (q.get('rtl') === '1') { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'fa'; }
  const b = memoryBackend({
    now: PREVIEW_NOW, responses: fixtureResponses(fixture, PREVIEW_NOW), settingsJson: q.get('settings') ?? undefined,
    historyJson: q.get('history') === '1' ? fixtureHistory(PREVIEW_NOW) : undefined,
  });
  const t0 = Date.now();
  b.now = () => PREVIEW_NOW + (Date.now() - t0); // moves forward from the fixture time so the page stays alive
  return b;
}

/** Last resort: if the page cannot start, say why instead of showing an empty window. Plain DOM, no framework. */
export function showFatal(message: string): void {
  const root = document.getElementById('root') ?? document.body;
  root.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.className = 'fatal';
  const h = document.createElement('h1'); h.textContent = 'Usage Bar could not start';
  const p = document.createElement('p'); p.textContent = message;
  const q = document.createElement('p'); q.textContent = 'Your data files were not changed. Close this window from the tray icon (Quit) and start the app again.';
  box.append(h, p, q);
  root.append(box);
  document.documentElement.dataset.ready = '1';
}

async function main() {
  const backend = await pickBackend();
  const engine = new Engine(backend);
  applyTheme(defaultSettings(), window.matchMedia('(prefers-color-scheme: dark)').matches);
  await engine.start();
  if (backend.kind === 'browser') await engine.first;
  (window as unknown as { __engine: Engine }).__engine = engine;
  render(<App engine={engine} />, document.getElementById('root')!);
  document.documentElement.dataset.ready = '1';
}
window.addEventListener('unhandledrejection', (e) => { if (!document.getElementById('root')?.children.length) showFatal(String((e.reason as Error)?.message ?? e.reason)); });
main().catch((e) => showFatal(String((e as Error)?.message ?? e)));
