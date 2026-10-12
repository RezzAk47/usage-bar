// The app's own licence is PolyForm Noncommercial 1.0.0. LICENSE, package.json, the lock file root and Cargo.toml must agree,
// and the README must not still call the app MIT (third-party and CLI-Usage notices keep their own licences).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SPDX = 'PolyForm-Noncommercial-1.0.0';

describe('app licence', () => {
  it('LICENSE is the PolyForm Noncommercial 1.0.0 text with the required notice on top', () => {
    const lines = read('LICENSE').split('\n');
    expect(lines[0]).toBe('Required Notice: Copyright 2026 Razi Karimi (https://github.com/RezzAk47)');
    expect(lines[2]).toBe('# PolyForm Noncommercial License 1.0.0');
    expect(lines[4]).toBe('<https://polyformproject.org/licenses/noncommercial/1.0.0>');
  });
  it('package.json, package-lock.json and Cargo.toml use the same SPDX id', () => {
    expect(JSON.parse(read('package.json')).license).toBe(SPDX);
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].license).toBe(SPDX);
    expect(read('src-tauri/Cargo.toml')).toMatch(new RegExp(`^license = "${SPDX}"$`, 'm'));
  });
  it('README states the new licence and no longer has an MIT badge', () => {
    const readme = read('README.md');
    expect(readme).toContain('https://polyformproject.org/licenses/noncommercial/1.0.0/');
    expect(readme).not.toMatch(/badge\/license-MIT/);
    expect(readme).not.toMatch(/^MIT\. See \[LICENSE\]/m);
  });
});
