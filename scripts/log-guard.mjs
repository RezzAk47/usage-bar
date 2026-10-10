// Fails if a logging crate appears in Cargo.lock: a logger could print request headers, including the Authorization token.
// (The Rust test `log_guard` checks the same thing and that the log crate is compiled with max_level_off.)
import fs from 'node:fs';
const lock = fs.readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
const banned = ['tauri-plugin-log', 'env_logger', 'fern', 'tracing-subscriber', 'flexi_logger', 'simplelog', 'pretty_env_logger', 'stderrlog'];
const lines = lock.split(/\r?\n/);
const found = banned.filter((b) => lines.includes(`name = "${b}"`));
const toml = fs.readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
if (found.length) { console.error(`log-guard: logger crate(s) ${found.join(', ')} in Cargo.lock. A logger can print Authorization headers; remove it or review this guard on purpose.`); process.exit(1); }
if (!/log = \{ version = "0\.4", features = \[[^\]]*"max_level_off"/.test(toml)) { console.error('log-guard: Cargo.toml must keep the log crate with the max_level_off feature'); process.exit(1); }
console.log('log-guard: no logger crate in Cargo.lock, log is compiled out');
