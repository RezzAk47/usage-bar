// Test helpers: a Node-backed FileIO that behaves like the Rust one (atomic write, exact integer stamps, CAS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, FileIO, FileStamp, sameStamp } from '../src/core/io';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usagebar-test-'));
}

export function statOf(file: string): FileStamp | null {
  try { const s = fs.statSync(file, { bigint: true }); return { size: Number(s.size), mtimeUs: Number(s.mtimeNs / 1000n), ctimeUs: Number(s.ctimeNs / 1000n), ino: String(s.ino) }; } catch { return null; }
}

export function nodeIO(dir: string): FileIO & { dir: string } {
  const p = (n: string) => path.join(dir, n);
  return {
    dir,
    async read(n) { try { return fs.readFileSync(p(n), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
    async stat(n) { return statOf(p(n)); },
    async write(n, text, expected) {
      fs.mkdirSync(dir, { recursive: true });
      if (expected !== undefined && !sameStamp(statOf(p(n)), expected)) throw new ConflictError();
      const tmp = path.join(dir, `.${n}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.renameSync(tmp, p(n));
    },
    async moveAside(n, backup) { const to = backup.replace(/\.json$/, `-${Math.random().toString(36).slice(2, 8)}.json`); fs.renameSync(p(n), p(to)); return to; },
  };
}

/** Make the mtime differ even on coarse file systems. */
export function bumpMtime(file: string, secs = 5): void {
  const t = new Date(Date.now() + secs * 1000);
  fs.utimesSync(file, t, t);
}
