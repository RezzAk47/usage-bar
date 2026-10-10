// The browser preview backend: an in-memory data folder and canned provider responses. Used by `vite dev`, the Playwright
// screenshots and the CI screenshot job. It never touches a real file or the network.
import type { Backend } from './types';
import { ConflictError, sameStamp, type FileIO, type FileStamp } from '../core/io';
import type { FetchResult, ProviderId } from '../core/model';

export class MemoryIO implements FileIO {
  files = new Map<string, { text: string; stamp: FileStamp }>();
  private counter = 1;
  async read(name: string) { return this.files.get(name)?.text ?? null; }
  async stat(name: string) { return this.files.get(name)?.stamp ?? null; }
  async write(name: string, text: string, expected?: FileStamp | null) {
    if (expected !== undefined && !sameStamp(this.files.get(name)?.stamp ?? null, expected)) throw new ConflictError();
    this.files.set(name, { text, stamp: { size: text.length, mtimeUs: 1_000_000_000 + this.counter++, ino: String(this.counter) } });
  }
  async moveAside(name: string, backup: string) {
    const f = this.files.get(name);
    const to = backup.replace(/\.json$/, `-${this.counter++}.json`);
    if (f) { this.files.set(to, f); this.files.delete(name); }
    return to;
  }
}

export interface MemoryOptions {
  now?: number; // ms
  responses?: Partial<Record<ProviderId, FetchResult | (() => Promise<FetchResult>)>>;
  settingsJson?: string;
  historyJson?: string;
  alertsJson?: string;
  notify?: (title: string, body: string) => boolean;
}

export function memoryBackend(opts: MemoryOptions = {}): Backend & { io: MemoryIO; notices: Array<{ title: string; body: string }>; fetches: ProviderId[] } {
  const io = new MemoryIO();
  if (opts.settingsJson !== undefined) void io.write('settings.json', opts.settingsJson);
  if (opts.historyJson !== undefined) void io.write('usage-history.json', opts.historyJson);
  if (opts.alertsJson !== undefined) void io.write('usage-alerts.json', opts.alertsJson);
  const listeners = new Set<() => void>();
  const timer = setInterval(() => listeners.forEach((l) => l()), 2000);
  (timer as unknown as { unref?: () => void }).unref?.();
  const notices: Array<{ title: string; body: string }> = [];
  const fetches: ProviderId[] = [];
  return {
    kind: 'browser', platform: 'macos', io, dataDir: '(browser preview: nothing is saved)', testMode: true, trayNote: null,
    now: opts.now !== undefined ? () => opts.now! : Date.now,
    notices, fetches,
    async fetchUsage(id) {
      fetches.push(id);
      const r = opts.responses?.[id];
      if (typeof r === 'function') return r();
      return r ?? { id, status: 'not_installed' };
    },
    async notify(n) { notices.push(n); return opts.notify ? opts.notify(n.title, n.body) : true; },
    async setTrayLabel() {}, async hide() {}, async quit() {}, async openUsagePage() {},
    autostart: null,
    onTick(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onSlept() { return () => {}; },
    onShown() { return () => {}; },
  };
}
