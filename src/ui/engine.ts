// The page's brain: refresh schedule, merge of stale numbers, alerts, history, tray label. No DOM here, so it is tested in Node.
import type { Backend } from '../backend/types';
import { Alerts } from '../core/alerts';
import { ALERTS_FILE, BACKOFF_FILE, HISTORY_FILE } from '../core/datadir';
import { History } from '../core/history';
import { Queue, errMessage } from '../core/io';
import { FetchSchedule, FetchResult, Provider, ProviderId, emptyProvider, isFailed, mergeStaleOne, scrub } from '../core/model';
import { providerFromFetch } from '../core/parse';
import { AppSettings } from '../core/settings';
import { SettingsStore } from '../core/settingsStore';
import { trayText, trayTooltip } from '../core/tray';

export const IDS: ProviderId[] = ['claude', 'codex'];

export class Engine {
  providers: Provider[] = IDS.map((id) => emptyProvider(id, 'unavailable'));
  /** Providers that have not answered yet. */
  loading = new Set<ProviderId>(IDS);
  stale = new Set<ProviderId>();
  /** Epoch seconds of the last refresh that brought numbers. */
  updated: number | null = null;
  settings: SettingsStore;
  history: History | null = null;
  alerts: Alerts | null = null;
  schedule: FetchSchedule;
  autostart: boolean | null = null;
  ioError: string | null = null;
  private fetching = new Set<ProviderId>();
  private writes = new Queue();
  private listeners = new Set<() => void>();
  private offs: Array<() => void> = [];
  private lastMinute = -1;
  private lastLabel = '';
  private started = false;
  /** Epoch seconds of the last manual Refresh click. */
  private lastManual = -1e12;
  /** Resolves when the first refresh round is done (tests, screenshots). */
  first: Promise<void> = Promise.resolve();

  constructor(public backend: Backend, rand: () => number = Math.random) {
    this.settings = new SettingsStore(backend.io);
    this.schedule = new FetchSchedule(IDS, rand);
  }

  nowSec(): number { return this.backend.now() / 1000; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of [...this.listeners]) l(); }

  get s(): AppSettings { return this.settings.settings; }

  private persist(file: string, text: string): void {
    void this.writes.run(() => this.backend.io.write(file, text)).then(() => { this.ioError = null; }, (e) => { this.ioError = `could not save ${file} (${scrub(errMessage(e), 100)})`; this.emit(); });
  }

  /** Resolves when every queued file write has finished (tests, shutdown). */
  flush(): Promise<void> { return this.writes.run(async () => undefined); }

  /** Loads settings, history and alert state, then starts following the tick. Never rejects. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.settings.init();
    const read = async (name: string) => { try { return await this.backend.io.read(name); } catch { return null; } };
    const clock = () => this.nowSec();
    this.history = new History(await read(HISTORY_FILE), clock, (t) => this.persist(HISTORY_FILE, t));
    this.alerts = new Alerts({ text: await read(ALERTS_FILE), clock, deliver: (n) => this.backend.notify(n), persist: (t) => this.persist(ALERTS_FILE, t) });
    this.schedule.load(await read(BACKOFF_FILE), this.nowSec());
    try { this.autostart = this.backend.autostart ? await this.backend.autostart.isEnabled() : null; } catch { this.autostart = null; }
    this.offs.push(this.backend.onTick(() => void this.tick()));
    this.offs.push(this.backend.onSlept(() => { this.schedule.stagger(this.nowSec()); void this.tick(); })); // after wake: 5 to 15 s apart, not both at once
    this.emit();
    this.first = this.tick(); // not awaited: the popup opens at once and shows 'Loading…' while a slow provider answers
  }

  stop(): void { this.offs.forEach((o) => o()); this.offs = []; this.started = false; }

  /** For a provider with no numbers yet: why it is not loading right now (a failure from before a restart is still waiting out its backoff). */
  waiting(id: ProviderId): boolean { return this.loading.has(id) && (this.schedule.failures[id] ?? 0) > 0 && (this.schedule.nextAt[id] ?? 0) > this.nowSec(); }

  static COOLDOWN_S = 10;

  /** Seconds until the Refresh button works again (0 = ready). */
  cooldownLeft(): number {
    // capped: a wall clock set back after a click must not lock the button for the size of the change
    return Math.min(Engine.COOLDOWN_S, Math.max(0, Math.ceil(this.lastManual + Engine.COOLDOWN_S - this.nowSec())));
  }

  /** The Refresh button: every provider is due now (backoff is skipped on purpose), at most once per 10 s. */
  refreshNow(): Promise<void> {
    if (this.cooldownLeft() > 0) return Promise.resolve();
    this.lastManual = this.nowSec();
    this.schedule.expedite(this.lastManual);
    this.emit();
    return this.tick();
  }

  async tick(): Promise<void> {
    const now = this.nowSec();
    const minute = Math.floor(now / 60);
    void this.settings.recheck().then(() => this.emit());
    const due = this.schedule.due(now).filter((id) => !this.fetching.has(id as ProviderId)) as ProviderId[];
    if (due.length) await Promise.all(due.map((id) => this.refreshOne(id)));
    else if (minute !== this.lastMinute) this.emit(); // the countdown text moves with the clock
    this.lastMinute = minute;
  }

  private async refreshOne(id: ProviderId): Promise<void> {
    this.fetching.add(id);
    let res: FetchResult;
    try { res = await this.backend.fetchUsage(id); }
    catch (e) { res = { id, status: 'unavailable', reason: scrub(errMessage(e), 80) }; }
    const now = this.nowSec();
    let next: Provider;
    try { next = providerFromFetch(res, now); } catch { next = emptyProvider(id, 'unavailable'); next.notes = ['usage unavailable (unexpected response)']; }
    const idx = this.providers.findIndex((p) => p.id === id);
    const prev = this.providers[idx];
    const merged = mergeStaleOne(next, this.loading.has(id) ? undefined : prev);
    this.providers[idx] = merged.provider;
    this.loading.delete(id);
    if (merged.stale) this.stale.add(id); else this.stale.delete(id);
    const failed = isFailed(next);
    this.schedule.record(id, !failed, now); // a first fetch that fails counts
    this.persist(BACKOFF_FILE, this.schedule.serialize());
    if (!failed && next.limits.length) {
      this.updated = now;
      this.alerts?.check([next], this.settings.settings, this.stale); // fresh numbers only: never the stale ones
      this.history?.record([next]);
    }
    this.fetching.delete(id);
    this.label();
    this.emit();
  }

  /** Pushes the tray text and tooltip when they changed. */
  private label(): void {
    const text = trayText(this.providers), tip = trayTooltip(this.providers, this.stale.size > 0);
    const key = `${text}\n${tip}`;
    if (key === this.lastLabel) return;
    this.lastLabel = key;
    void this.backend.setTrayLabel(text ? `${text}\n${tip}` : tip).catch(() => undefined);
  }

  update(patch: Partial<AppSettings>): Promise<void> { return this.settings.update(patch).then(() => this.emit()); }
  reset(): Promise<void> { return this.settings.resetToDefaults().then(() => this.emit()); }
  async setAutostart(on: boolean): Promise<void> {
    try { await this.backend.autostart?.set(on); this.autostart = await this.backend.autostart!.isEnabled(); } catch { /* the toggle shows the real state */ }
    this.emit();
  }
}
