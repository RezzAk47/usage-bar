/** Which version of a file was seen: size and times, plus the inode (Unix) so a same-size same-mtime replacement still differs. */
/**
 * Every field is an exact integer or a string, so a stamp survives JSON (Rust -> page -> Rust) bit for bit: times are whole
 * microseconds since the epoch (below 2^53 until the year 2255), the inode is text. Never use fractional milliseconds here: they
 * do not always round-trip through JSON and made the compare-and-swap raise false conflicts.
 */
export interface FileStamp { size: number; mtimeUs: number; ctimeUs?: number; ino?: string }

/** The door to the data folder. The Tauri build backs it with Rust commands that only touch files inside the data dir. */
export interface FileIO {
  /** null = the file does not exist. A UTF-8 byte order mark is not part of the returned text. */
  read(name: string): Promise<string | null>;
  stat(name: string): Promise<FileStamp | null>;
  /**
   * Atomic (temp file + fsync + rename); a symlinked file keeps being a link. `expected` makes it a compare-and-swap:
   * undefined = no check, null = the file must not exist, a stamp = the file must still be exactly that one. A file that
   * changed makes it fail with a ConflictError. The Tauri side holds the same lock file as tools/tick.py around check + write.
   */
  write(name: string, text: string, expected?: FileStamp | null): Promise<void>;
  /** Keeps `name` under a unique `.broken-` name derived from `backupName`. Returns the name used. */
  moveAside(name: string, backupName: string): Promise<string | void>;
}

export const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && a.mtimeUs === b.mtimeUs && (a.ctimeUs ?? 0) === (b.ctimeUs ?? 0) && (a.ino ?? '') === (b.ino ?? ''));

export class ConflictError extends Error {
  constructor(message = 'CONFLICT: the file changed on disk') { super(message); this.name = 'ConflictError'; }
}
export const isConflict = (e: unknown): boolean => e instanceof ConflictError || errMessage(e).includes('CONFLICT');

/** Errors from Tauri commands are plain strings; make any thrown value a readable message. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Runs async jobs one after the other, so two clicks never interleave their load-modify-save steps. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
