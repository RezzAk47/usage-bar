// The desktop backend: a handful of Rust commands. The page can read and write only the app's data files; it cannot reach the
// network (CSP connect-src has no hosts) and never receives a token.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { Backend, Platform } from './types';
import { ConflictError, errMessage, isConflict, type FileStamp } from '../core/io';
import type { FetchResult, ProviderId } from '../core/model';
import { scrub } from '../core/model';

interface AppInfo { platform: Platform; dataDir: string; trayNote: string | null; testMode: boolean }

function subscribe<T>(event: string, cb: (p: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  void listen<T>(event, (e) => cb(e.payload)).then((u) => { if (dead) u(); else off = u; });
  return () => { dead = true; off?.(); };
}

export async function tauriBackend(): Promise<Backend> {
  const info = await invoke<AppInfo>('app_info');
  return {
    kind: 'tauri', platform: info.platform, dataDir: info.dataDir, now: Date.now, trayNote: info.trayNote, testMode: info.testMode,
    io: {
      read: (name) => invoke<string | null>('fs_read', { name }).catch((e) => { throw new Error(errMessage(e)); }),
      stat: (name) => invoke<FileStamp | null>('fs_stat', { name }).catch((e) => { throw new Error(errMessage(e)); }),
      write: (name, text, expected) => invoke<void>('fs_write', { name, text, check: expected !== undefined, expected: expected ?? null }).catch((e) => { throw isConflict(e) ? new ConflictError(errMessage(e)) : new Error(errMessage(e)); }),
      moveAside: (name, backupName) => invoke<string>('fs_move_aside', { name, backupName }),
    },
    async fetchUsage(id: ProviderId): Promise<FetchResult> {
      try { return await invoke<FetchResult>('fetch_usage', { provider: id }); }
      catch (e) { return { id, status: 'unavailable', reason: scrub(errMessage(e), 80) }; }
    },
    async notify(n) { try { await invoke('notify', { title: n.title, body: n.body }); return true; } catch { return false; } },
    setTrayLabel: (label) => invoke<void>('set_tray_label', { label }),
    hide: () => invoke<void>('hide_popup'),
    quit: () => invoke<void>('quit_app'),
    openUsagePage: (id) => invoke<void>('open_usage_page', { provider: id }),
    autostart: { isEnabled: () => isEnabled(), set: (on) => (on ? enable() : disable()) },
    onTick: (cb) => subscribe<null>('tick', () => cb()),
    onSlept: (cb) => subscribe<{ at: number }>('slept', (p) => cb(p.at)),
    onShown: (cb) => subscribe<null>('popup-shown', () => cb()),
  };
}
