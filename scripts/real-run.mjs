// A short REAL run of the built app against FAKE credentials and a FAKE local server, then a search for the fake tokens.
// Usage: node scripts/real-run.mjs [path-to-binary] [seconds]     (default binary: src-tauri/target/debug/usage-bar-cross)
// Nothing real is read: the credential files are made here, the "providers" are a local server on 127.0.0.1, HOME points at a
// temp folder. Asserts: tray created, both fetches made with the right fake tokens, files written, ZERO hits for a token in
// the data folder, the fake HOME, stdout/stderr (which includes every IPC payload the app logs in test mode).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

if (process.platform !== 'darwin' && !process.env.USAGEBAR_FORCE_REAL_RUN) {
  console.log(`real-run: skipped on ${process.platform} (CI runs it on macOS only; set USAGEBAR_FORCE_REAL_RUN=1 to try elsewhere: it uses SIGTERM and ~/Library paths)`);
  process.exit(0);
}
const bin = process.argv[2] ?? 'src-tauri/target/debug/usage-bar-cross';
const seconds = Number(process.argv[3] ?? 10);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'usagebar-real-'));
const [data, home, creds, claudeDir, codexDir] = ['data', 'home', 'creds', 'creds/claude', 'creds/codex'].map((d) => { const p = path.join(T, d); fs.mkdirSync(p, { recursive: true }); return p; });
// awkward on purpose: quotes, backslash, slash, plus, equals, angle brackets, non-ASCII is refused by validation so it is not used here
const CLAUDE_TOKEN = 'FAKE+CLAUDE/TOK<en>\\q"=-' + 'c1'.repeat(14);
const CODEX_TOKEN = 'FAKE-CODEX-TOKEN-' + 'x9'.repeat(14);
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: Date.now() + 3600_000, subscriptionType: 'max' } }), { mode: 0o600 });
fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: CODEX_TOKEN, account_id: 'acct-fake-1' } }), { mode: 0o600 });

const seen = [];
const nowS = Math.floor(Date.now() / 1000);
const escU = (t) => t.replace(/[A-Za-z0-9]/g, (c) => '\\u00' + c.charCodeAt(0).toString(16));
const echoes = (auth) => {
  const tok = auth.slice(7);
  const b64 = Buffer.from(auth).toString('base64');
  return {
    echo_debug: auth, echo_tok: tok, echo_b64: b64, echo_b64url: b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), echo_b64tok: Buffer.from(tok).toString('base64'),
    echo_url: encodeURIComponent(auth), echo_url_lower: encodeURIComponent(tok).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), echo_esc: escU(auth), echo_rev: [...tok].reverse().join(''),
    echo_piece: tok.slice(5, 15), [tok]: 1, [b64]: { utilization: 1 }, plan_note: '<img src=x onerror=alert(1)>\u202Eevil',
  };
};
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  const okTok = req.url.startsWith('/api/oauth/usage') ? auth === `Bearer ${CLAUDE_TOKEN}` : auth === `Bearer ${CODEX_TOKEN}`;
  seen.push({ url: req.url, authOk: okTok, beta: req.headers['anthropic-beta'] ?? null, account: req.headers['chatgpt-account-id'] ?? null });
  res.setHeader('content-type', 'application/json');
  if (!okTok) { res.statusCode = 401; res.end('{}'); return; }
  if (req.url.startsWith('/api/oauth/usage')) {
    res.end(JSON.stringify({ ...echoes(auth), five_hour: { utilization: 85.0, resets_at: new Date((nowS + 8000) * 1000).toISOString(), echo: auth }, seven_day: { utilization: 40, resets_at: new Date((nowS + 300000) * 1000).toISOString() } }));
  } else {
    res.end(JSON.stringify({ ...echoes(auth), plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: nowS + 3600 }, secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: nowS + 90000 } } }));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const out = fs.openSync(path.join(T, 'stdout.log'), 'w'), err = fs.openSync(path.join(T, 'stderr.log'), 'w');
const child = spawn(bin, [], {
  stdio: ['ignore', out, err],
  env: { ...process.env, HOME: home, USERPROFILE: home, USAGEBAR_TEST: '1', USAGEBAR_DATA_DIR: data, USAGEBAR_CLAUDE_DIR: claudeDir, USAGEBAR_CODEX_DIR: codexDir, USAGEBAR_API_BASE_CLAUDE: base, USAGEBAR_API_BASE_CODEX: base, HTTPS_PROXY: '', HTTP_PROXY: '' },
});
let exited = null;
child.on('exit', (c, s) => { exited = { c, s }; });
await new Promise((r) => setTimeout(r, seconds * 1000));
const wasRunning = exited === null;
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
if (exited === null) child.kill('SIGKILL');
server.close();

const stderr = fs.readFileSync(path.join(T, 'stderr.log'), 'utf8');
const stdout = fs.readFileSync(path.join(T, 'stdout.log'), 'utf8');
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log('FAIL', m); } else console.log('ok  ', m); };

ok(wasRunning, `the app was still running after ${seconds} s (not crashed)`);
ok(/usage-bar: tray icon created/.test(stderr), 'tray icon created');
ok(seen.some((s) => s.url.startsWith('/api/oauth/usage') && s.authOk && s.beta === 'oauth-2025-04-20'), 'Claude fetch reached the fake server with the right fake token and beta header');
ok(seen.some((s) => s.url.startsWith('/backend-api/wham/usage') && s.authOk && s.account === 'acct-fake-1'), 'Codex fetch reached the fake server with the right fake token and account id');
ok(seen.every((s) => s.authOk), 'no request was made with a wrong token');
const ipc = stderr.split('\n').filter((l) => l.includes('ipc fetch_usage'));
ok(ipc.length >= 2, `IPC payloads captured (${ipc.length} lines)`);
ok(ipc.some((l) => l.includes('"status":"ok"') && l.includes('"id":"claude"')) && ipc.some((l) => l.includes('"id":"codex"')), 'both providers answered ok through IPC');
ok(ipc.every((l) => !l.includes('<img') && !l.includes('echo_') && !l.includes('plan_note')), 'the IPC payload carries only whitelisted fields (no echoed or provider-controlled extras)');
const label = stderr.split('\n').filter((l) => l.includes('tray-label')).pop() ?? '';
console.log('last tray label line:', label);
ok(/text="\d+% left"/.test(label), 'tray text says "N% left"');
ok(/lowest/.test(label), 'tray tooltip says lowest');
const files = fs.readdirSync(data);
console.log('data folder:', files.join(', '));
ok(files.includes('usage-history.json'), 'usage-history.json was written');
ok(!files.some((f) => f.includes('.tmp')), 'no temp file left behind');
ok(/notify "Claude Code: 5h limit 85% used"/.test(stderr), 'an 85% alert was delivered through the notify command');
ok(files.includes('usage-alerts.json'), 'usage-alerts.json was written after the delivery succeeded');

function walk(dir) { const o = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walk(p)); else if (e.isFile()) o.push(p); } return o; }
// the REAL ~/Library folders a webview of this app would use (WebKit storage and caches), searched too
const extra = [];
const lib = path.join(os.homedir(), 'Library');
for (const sub of ['WebKit', 'Caches', 'Application Support', 'HTTPStorages', 'Saved Application State', 'Preferences', 'Logs']) {
  const root = path.join(lib, sub);
  let names = []; try { names = fs.readdirSync(root); } catch { /* not there */ }
  for (const n of names) if (/usagebar|usage-bar|UsageBar/i.test(n)) { const p = path.join(root, n); try { extra.push(...(fs.statSync(p).isDirectory() ? walk(p) : [p])); } catch { /* unreadable */ } }
}
console.log('real ~/Library app folders searched:', extra.length, 'files');
const targets = [...walk(data), ...walk(home), ...extra, path.join(T, 'stdout.log'), path.join(T, 'stderr.log')];
const B = Buffer.from('Bearer ' + CLAUDE_TOKEN).toString('base64');
const leakForms = [CLAUDE_TOKEN, CODEX_TOKEN, 'c1c1c1c1c1c1c1c1', 'x9x9x9x9x9x9x9x9', B, B.replace(/=+$/, ''), Buffer.from(CLAUDE_TOKEN).toString('base64'), encodeURIComponent(CLAUDE_TOKEN), JSON.stringify(CLAUDE_TOKEN).slice(1, -1), escU(CLAUDE_TOKEN), [...CLAUDE_TOKEN].reverse().join(''), CLAUDE_TOKEN.slice(5, 15), CODEX_TOKEN.slice(5, 15)];
let hits = 0;
for (const f of targets) {
  let buf; try { buf = fs.readFileSync(f); } catch { continue; }
  for (const tok of leakForms) {
    if (buf.includes(tok) || buf.includes(Buffer.from(tok, 'utf16le'))) { hits++; console.log('TOKEN FOUND in', f); }
  }
}
// positive control: the same search DOES find the fake token where it really is (the fake credential file)
ok(walk(creds).some((f) => fs.readFileSync(f).includes(JSON.stringify(CLAUDE_TOKEN).slice(1, -1))), 'control: the search finds the fake token in the fake credential file');
ok(hits === 0, `zero token hits in ${targets.length} files (data folder, fake HOME, stdout, stderr/IPC capture)`);
console.log(`searched: ${data}, ${home}, stdout.log, stderr.log (the credential files in ${creds} are the only place the fake tokens exist)`);
console.log('temp folder kept for inspection:', T);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('real-run: all checks passed');
