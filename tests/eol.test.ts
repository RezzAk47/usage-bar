// Windows checkouts must not turn tracked sources and fixtures into CRLF (it breaks byte-exact fixtures and the shell/script files).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const textExt = /\.(ts|tsx|json|mjs|css|html|rs|toml|yml|md|lock)$/;
describe('line endings', () => {
  it('.gitattributes forces LF and marks images binary', () => {
    const a = fs.readFileSync(fileURLToPath(new URL('../.gitattributes', import.meta.url)), 'utf8');
    expect(a).toMatch(/^\* text=auto eol=lf$/m);
    expect(a).toMatch(/^\*\.png binary$/m);
    expect(a).toMatch(/^tests\/fixtures\/\*\* text eol=lf$/m);
  });
  it('no tracked text file contains a carriage return', () => {
    let files: string[];
    try { files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return; } // not a git checkout (tarball): nothing to check
    const bad = files.filter((f) => textExt.test(f) && fs.existsSync(root + f) && fs.readFileSync(root + f, 'utf8').includes('\r'));
    expect(bad).toEqual([]);
  });
});
