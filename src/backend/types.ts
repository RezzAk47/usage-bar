import type { FileIO } from '../core/io';
import type { FetchResult, ProviderId } from '../core/model';
import type { Notice } from '../core/alerts';

export type Platform = 'macos' | 'windows' | 'linux';

/** Everything the page needs from the operating system. The Tauri build and the browser preview each provide one. */
export interface Backend {
  kind: 'tauri' | 'browser';
  platform: Platform;
  io: FileIO;
  dataDir: string;
  /** Milliseconds since the epoch (the browser preview can pin it). */
  now: () => number;
  /** Asks Rust to read the credentials and the provider. The page never sees a token; this returns a status and the response only. */
  fetchUsage(id: ProviderId): Promise<FetchResult>;
  /** Shows one notification; true only when the OS accepted it. */
  notify(n: Notice): Promise<boolean>;
  setTrayLabel(label: string): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  /** Opens the provider's usage page in the browser (fixed URLs, chosen in Rust). */
  openUsagePage(id: ProviderId): Promise<void>;
  autostart: { isEnabled(): Promise<boolean>; set(on: boolean): Promise<void> } | null;
  /** About every 2 seconds (from Rust in the app, a timer in the browser). */
  onTick(cb: () => void): () => void;
  /** Called when the computer went to sleep (wall-clock ms of the last tick before it). */
  onSlept(cb: (at: number) => void): () => void;
  onShown(cb: () => void): () => void;
  trayNote: string | null;
  /** USAGEBAR_SELFTEST=1 / test runs: the page reports what it did to the tray label. */
  testMode: boolean;
}
