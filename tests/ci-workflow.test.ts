// The CI workflow cannot be run here, so its hardening is checked as text: timeouts, one run per branch, read-only token,
// and a clearly marked TODO while the actions are still pinned to tags instead of commit SHAs.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const yml = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const toml = fs.readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('CI workflow hardening', () => {
  it('every job has a timeout', () => {
    const jobs = [...yml.matchAll(/^  ([a-z-]+):\n    (?:name:.*\n    )?runs-on:/gm)].length;
    expect(jobs).toBe(2);
    expect([...yml.matchAll(/^    timeout-minutes: 30$/gm)].length).toBe(jobs);
  });
  it('duplicate runs of one branch cancel each other', () => {
    expect(yml).toMatch(/^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}\n  cancel-in-progress: true/m);
  });
  it('the token is read-only', () => expect(yml).toMatch(/^permissions:\n  contents: read$/m));
  it('every action is pinned to a full commit SHA', () => {
    const uses = [...yml.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
    expect(uses.length).toBeGreaterThan(5);
    const unpinned = uses.filter((u) => !/^[0-9a-f]{40}$/.test(u[2]));
    expect(unpinned).toEqual([]);
  });
  it('builds are locked and installs run no scripts', () => {
    expect(yml).toContain('cargo test --locked');
    expect(yml).toContain('cargo clippy --locked --all-targets -- -D warnings');
    expect(yml).toMatch(/tauri build -- --debug --bundles \$\{\{ matrix\.bundles \}\} -- --locked/);
    expect([...yml.matchAll(/npm ci --ignore-scripts/g)].length).toBe(2);
    expect(yml).not.toMatch(/npm ci(?! --ignore-scripts)/);
  });
  it('the token-leak run and the log-crate guard are CI steps', () => {
    expect(yml).toContain('npm run token-leak');
    expect(yml).toContain('npm run log-guard');
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['token-leak']).toContain('real-run.mjs');
    expect(pkg.scripts['log-guard']).toContain('log-guard.mjs');
  });
  it('the Rust version in Cargo.toml, README and CI agree', () => {
    expect(toml).toMatch(/rust-version = "1\.90"/);
    expect(readme).toMatch(/1\.90/);
    expect(readme).not.toMatch(/1\.80/);
    expect(yml).toContain('1.90');
  });
});
