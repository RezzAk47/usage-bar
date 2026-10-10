// settings.json: strict about what it will overwrite. A file that cannot be read is never overwritten, unknown keys
// survive a save, a hand edit made while the app runs is merged (only the keys changed here are applied on top).
import { FileIO, FileStamp, Queue, errMessage, sameStamp } from './io';
import { SETTINGS_FILE } from './datadir';
import { stableStringify, Extra } from './json';
import { AppSettings, defaultSettings, mergeSettings, parseSettings, settingsToObject, validated } from './settings';

export class SettingsStore {
  settings: AppSettings = defaultSettings();
  loadError: string | null = null;
  saveError: string | null = null;
  /** Values in settings.json that were ignored because of their type. Cleared by the next save. */
  ignoredNotes: string[] = [];

  private lastStamp: FileStamp | null = null;
  private baseline: AppSettings = defaultSettings();
  private extra: Extra = {};
  private queue = new Queue();
  private listeners = new Set<() => void>();

  constructor(private io: FileIO) {}

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of [...this.listeners]) l(); }

  init(): Promise<void> { return this.queue.run(async () => { try { await this.load(); } catch (e) { this.saveError = errMessage(e); } this.emit(); }); }

  /** If settings.json was unreadable or changed outside, look again. Cheap when nothing changed. */
  recheck(): Promise<void> {
    return this.queue.run(async () => {
      try {
        const stamp = await this.io.stat(SETTINGS_FILE);
        if (sameStamp(stamp, this.lastStamp) && this.loadError === null) return;
        if (this.loadError !== null || !sameStamp(stamp, this.lastStamp)) { await this.load(); this.emit(); }
      } catch (e) { this.saveError = errMessage(e); this.emit(); }
    });
  }

  private async load(): Promise<void> {
    let stamp: FileStamp | null;
    let text: string | null;
    try {
      stamp = await this.io.stat(SETTINGS_FILE);
      text = stamp === null ? null : await this.io.read(SETTINGS_FILE);
    } catch (e) {
      // not UTF-8 text, too big, permissions ...: defaults are in use, the file is left alone, and the window still renders
      this.settings = defaultSettings(); this.baseline = defaultSettings(); this.extra = {}; this.lastStamp = null;
      this.loadError = `settings.json could not be read (${errMessage(e)}). Defaults are in use and the file is untouched.`;
      return;
    }
    if (text === null) {
      // No file (never made, or the user deleted a broken one): defaults are in use and saving is allowed again.
      this.settings = defaultSettings(); this.baseline = defaultSettings(); this.extra = {}; this.lastStamp = stamp;
      this.loadError = null; this.saveError = null; this.ignoredNotes = [];
      return;
    }
    try {
      const p = parseSettings(text);
      this.settings = p.settings; this.ignoredNotes = p.notes; this.extra = p.extra;
      this.baseline = p.settings; this.lastStamp = stamp;
      this.loadError = null; this.saveError = null;
    } catch (e) {
      this.settings = defaultSettings(); this.baseline = defaultSettings(); this.extra = {}; this.lastStamp = stamp;
      this.loadError = `settings.json could not be read (${(e as Error).message}). Defaults are in use and the file is untouched.`;
    }
  }

  /** Change one or more settings and save. */
  update(patch: Partial<AppSettings>): Promise<void> {
    return this.queue.run(async () => {
      this.settings = validated({ ...this.settings, ...patch });
      try { await this.save(); } catch (e) { this.saveError = errMessage(e); }
      this.emit();
    });
  }

  private async save(): Promise<boolean> {
    if (this.loadError !== null) return false; // never overwrite a file we could not read
    try {
      let toSave = this.settings;
      let extra = this.extra;
      const stamp = await this.io.stat(SETTINGS_FILE);
      if (stamp !== null) {
        const old = await this.io.read(SETTINGS_FILE);
        if (old !== null) {
          try {
            const disk = parseSettings(old);
            extra = disk.extra;
            if (!sameStamp(stamp, this.lastStamp)) {
              // Edited by hand while the app runs: start from the file and apply only the keys changed here.
              toSave = mergeSettings(disk.settings, this.settings, this.baseline);
              this.settings = toSave;
            }
          } catch (e) {
            // It became unreadable after launch: same as a file that was bad at launch. Do not overwrite it.
            this.loadError = `settings.json could not be read (${(e as Error).message}). Defaults are in use and the file is untouched.`;
            return false;
          }
        }
      }
      await this.io.write(SETTINGS_FILE, stableStringify(settingsToObject(toSave, extra)) + '\n');
      this.extra = extra;
      this.baseline = toSave;
      this.lastStamp = await this.io.stat(SETTINGS_FILE);
      this.saveError = null; this.ignoredNotes = [];
      return true;
    } catch (e) {
      this.saveError = (e as Error).message;
      return false;
    }
  }

  /** Back to defaults. A file that could not be read is kept as settings.broken-<time>.json first. */
  resetToDefaults(): Promise<void> {
    return this.queue.run(async () => {
      const stamp = await this.io.stat(SETTINGS_FILE);
      if (this.loadError === null && stamp !== null) {
        const text = await this.io.read(SETTINGS_FILE);
        try { if (text !== null) parseSettings(text); } catch { this.loadError = 'settings.json could not be read. Defaults are in use and the file is untouched.'; }
      }
      if (this.loadError !== null && stamp === null) {
        this.loadError = null; // already gone: nothing to keep
      } else if (this.loadError !== null) {
        try { await this.io.moveAside(SETTINGS_FILE, `settings.broken-${Date.now()}.json`); } catch (e) {
          this.saveError = `Could not keep a backup, so nothing was changed: ${(e as Error).message}`;
          this.emit();
          return;
        }
        this.loadError = null;
      }
      this.settings = defaultSettings();
      this.extra = {}; // a reset overrides any outside edit: no merge
      this.lastStamp = await this.io.stat(SETTINGS_FILE);
      await this.save();
      this.emit();
    });
  }
}
