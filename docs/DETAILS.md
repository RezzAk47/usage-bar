# Usage Bar: technical details

The [README](../README.md) is the short version. This page has the full detail: where the numbers come from, how
credentials are handled, what was tested, and how the app differs from the Mac usage bar it is based on.

## Disclaimer

The two usage endpoints (`/api/oauth/usage` and `/backend-api/wham/usage`) are **undocumented and unofficial**. They can
change or stop working at any time. Using CLI tokens with an unofficial endpoint may be outside what the providers' terms
allow. You use this app at your own risk, and the author is not responsible for any action a provider takes on your
account. If in doubt, do not use it.

Usage Bar is an independent project. It is not affiliated with, endorsed by or sponsored by the makers of the AI coding tools
it works with. Product names are trademarks of their respective owners (see `THIRD-PARTY-NOTICES.md`).

## Features in detail

- Provider cards: ring, `N% left`, `Resets 17:19 · in 2 h 14 min`, an OK / Low / Critical chip, header `Lowest N% left`.
- Tray text `63% left` (always "left", so it cannot be read as used) next to the icon on macOS; a tooltip on every OS.
- Alerts when a limit crosses 80% and 95% used (both adjustable 50 to 99): once per provider + limit + reset window, re-armed
  when usage falls 5 points, never for a provider whose refresh just failed, only counted as sent after the OS accepted the
  notification (3 retries, saved across restarts); more than 3 at once become one notification.
- 7-day sparkline per provider (a sample at most every 10 minutes, 1,100 samples per limit, 64 series, gaps over 2 h drawn as gaps).
- Settings: rows shown, alerts on/off and thresholds, history on/off, appearance, colour theme, layout (Cards, Glass, Solid,
  Compact), start at login. Light and dark. Keyboard and screen-reader friendly, right-to-left safe, works at small heights.
- Refresh every 60 s (±10% jitter). A provider that fails is retried after 120 / 240 / 480 / 600 s, on its own: a dead
  provider never slows down the healthy one. That backoff is saved (`usage-backoff.json`, absolute times, never more than
  10 minutes ahead after a clock change), so a restart does not reset it. The Refresh button waits 10 s between clicks; after
  the computer wakes, the two providers are fetched 5 to 15 s apart. The last good numbers stay on screen, marked "couldn't refresh".
- It uses the same file and key names as the Mac usage bar from CLI-Usage for `settings.json`, `usage-alerts.json` and
  `usage-history.json`.

## How the usage numbers are obtained

Neither provider documents a public usage API for subscription limits. This app uses the same sign-in tokens that the two
supported AI coding command-line tools store on your computer, and asks two endpoints that those tools' accounts are
accepted by today. **These endpoints are known from public behaviour (community tools and the CLIs' own traffic), not from
official documentation, and they were not tested against the real services while building this app** (see "What was verified"
below). They can change or stop working without notice.

| Provider | Source | Certainty |
| --- | --- | --- |
| First tool | `GET /api/oauth/usage` on that tool's API host, with `Authorization: Bearer <the tool's OAuth token>` and a fixed beta header. Response: windows such as `five_hour` and `seven_day`, each `{utilization: percent used, resets_at}`. | Medium. Endpoint and header are widely used by third-party tools; field names match the response shapes in the Mac bar's tests. Not officially documented. |
| Second tool | `GET /backend-api/wham/usage` on that tool's web host, with `Authorization: Bearer <the tool's token>` and an account-id header. Response: `rate_limit.primary_window` / `secondary_window` (`used_percent`, `limit_window_seconds`, `reset_at`), optional `additional_rate_limits`. | Medium to low. Same status. |
| Second tool, fallback | Runs that tool's own command-line program in `app-server` mode (fixed arguments, no shell, killed after 10 s) and calls `account/rateLimits/read`. Reply shape `{rateLimits: {planType, primary: {usedPercent, resetsAt}, secondary}}` is the one in the Mac bar's tests. | Medium for the reply shape, low for the exact request names (initialize / initialized / account/rateLimits/read). |

Because the shapes are uncertain, parsing is deliberately tolerant (strings, NaN, booleans, negatives, over 100, missing
fields, epoch seconds or milliseconds or ISO times with any number of fraction digits). A response with no readable limit is
shown as `usage unavailable (empty response)` and the last good numbers are kept. All of it is tested with mocks only. The two
URLs (with the two hosts) are constants in `src-tauri/src/usage.rs`. They are configurable **only for tests**: the
`USAGEBAR_API_BASE_*` overrides (loopback http only) and the program-path override work only when `USAGEBAR_TEST=1`; in a
normal run the hosts are fixed.

If an endpoint changes, the page shows `usage unavailable (reason)` and nothing else breaks.

## Credentials and safety

- The app reads the credential files **read-only** and never refreshes or writes tokens. Each supported tool keeps one in its
  hidden folder in your home directory (on Windows, under `%USERPROFILE%`); the tools' own folder-override variables are
  honoured. The exact file names are in `src-tauri/src/creds.rs`. A token that is expired (or refused with 401) shows a
  message asking you to sign in again in that tool.
- **macOS Keychain is out of scope.** One of the supported tools keeps its token in the Keychain on a Mac; this build does not read it. On a
  Mac it only works if the credentials file exists. Mac users should keep the native Python usage bar.
- A credential file is used only if it is a regular file (a link is refused), owned by you, at most 64 KB, opened without
  following links and checked again after opening. The token itself must be visible ASCII (no spaces, control or non-ASCII
  characters), 8 to 4096 characters, otherwise the app says "credential file has an invalid token". `expiresAt` is read as
  seconds (below 1e11), milliseconds (below 1e14), a numeric string or an ISO time; anything else means "no expiry information"
  and the request decides (a 401 means sign in again).
- The home folder is decided in one place: Windows `USERPROFILE`, then `HOMEDRIVE`+`HOMEPATH`, `HOME` only if both are missing;
  Unix `HOME`. With no home folder the app never falls back to the current folder: both providers show "unavailable", and if the
  data folder cannot be chosen (no `USAGEBAR_DATA_DIR`, `APPDATA` or `XDG_DATA_HOME` either) the app stops with a message.
- Tokens live only in Rust (`creds.rs`, `http.rs`, `usage.rs`) in a wrapper that cannot be printed. The page gets a status and
  a **whitelisted projection** of the provider's response, never a token: only numbers (used percent, window length, reset time),
  bounded reset strings, a plan name and window names made of letters, digits, space, `_` and `-` (at most 40 characters) survive;
  everything else is dropped in Rust. What is left is checked once more for the token in every encoding (raw, JSON-escaped,
  `\uXXXX`, base64, base64url, percent-encoded, reversed, with and without `Bearer`, and 8-character pieces of long tokens), as
  value or as key. Error texts are scrubbed (token-like runs and `Bearer ...` are replaced). The Authorization header is never
  logged: the `log` crate is compiled with `max_level_off`, so even ureq/rustls trace records cannot exist, and a test fails if a
  logger crate (tauri-plugin-log, env_logger, fern, tracing-subscriber, flexi_logger, simplelog) enters `Cargo.lock`. A panic
  prints only file and line. Provider-controlled text (labels, plan, notification and tray text) loses control characters and
  bidi / zero-width format characters and is cut to 40 characters.
- Network: one function (`http.rs`). https only, certificate verification on (rustls with bundled web roots, no way to switch
  it off), **no redirects**, only the two hosts above, 15 s timeout (a body that trickles in counts as a timeout), 1 MB response
  cap, JSON depth cap 12. **Proxies:** `HTTPS_PROXY` / `ALL_PROXY` are ignored by default so your token never goes through an
  unexpected proxy. Settings has "Use system proxy settings" (off); turn it on only if your network needs a proxy you trust.
  Rust reads that switch from `settings.json` itself.
- The page has no network access at all: the content security policy is `connect-src ipc: http://ipc.localhost` (no hosts),
  and the capability file lists only the app's own commands. The only files the page can touch are `settings.json`,
  `usage-alerts.json`, `usage-history.json`, `usage-backoff.json` (and `.broken-` backups) in the data folder, through Rust.
- Data folder: `%APPDATA%\UsageBar`, `~/Library/Application Support/UsageBar`, `${XDG_DATA_HOME:-~/.local/share}/UsageBar`
  (`USAGEBAR_DATA_DIR` overrides). Saves are atomic, compare-and-swap with exact **integer** file stamps (whole microseconds;
  no floating-point times, so no false CONFLICT) under a lock file. **A link in place of a data file is refused outright**
  ("is a link: not followed") for reading, stat and writing, as is a fifo or any non-regular file; the data folder itself may be
  a link you made. Reads happen off the main thread with a 5 s limit and open the file with `O_NOFOLLOW | O_NONBLOCK`, so a
  planted fifo cannot freeze the tray.
- **Program lookup.** The fallback needs the second tool's command-line program. A login item has a short PATH, so besides PATH the app looks
  in `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/.volta/bin` and
  the 5 newest `~/.nvm/versions/node/*/bin` (Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, `~\.bun\bin`, scoop shims),
  never the current directory, and Settings has a field for the program's path. A candidate must be an absolute path to a regular executable
  (a link to one is fine) owned by you or root. The child gets only PATH, the home folder, the tool's own home-folder variable and (Windows)
  SystemRoot/TEMP/TMP, and runs in its own process group (killed whole on exit or timeout; on Windows with `taskkill /T /F`).
  On Windows a `.cmd` shim is started as `cmd.exe /d /c <validated path> app-server` with fixed arguments; a path containing
  `% ^ & | < > " ( ) !` is refused. The Windows part is untested.

Dependencies: `ureq 3.4.2` (pinned), `log` with logging compiled out, `rustls`/`ring` for HTTP. `npm audit`: 0 vulnerabilities
at the time of writing. `cargo audit` was not run, so **no Rust advisory scan has been done**; run it before relying on this.

## All checks

```
npm ci --ignore-scripts
npm test                     # vitest: core, engine, palette contrast
npx tsc --noEmit
(cd src-tauri && cargo test --locked && cargo clippy --all-targets -- -D warnings)
npm run build && npm run ui:smoke && npm run shots     # browser checks and screenshots (Playwright, made-up data)
npm run tauri build -- --debug
npm run token-leak           # 10 s real run (macOS): fake credentials, hostile fake server, searches everything for the fake tokens in every encoding
npm run log-guard
```

A plain `cargo build` produces a binary that loads the dev server address (`devUrl`) instead of the built page, so the window
never starts. Use `npm run tauri build` (or `cargo build --features tauri/custom-protocol` after `npm run build`). CI builds
with `--locked`.

Test-only environment: `USAGEBAR_TEST=1`, `USAGEBAR_DATA_DIR`, plus per-tool folder, API base and program-path overrides (all
`USAGEBAR_*`; the full list is in `src-tauri/src/usage.rs` and `creds.rs`).

## What was verified, and what was not

Verified on the developer's Mac (macOS only): vitest, `tsc`, `cargo test`, `cargo clippy -D warnings`,
`npm run tauri build -- --debug`, the 10 s real run (tray created, both fetches reach a fake server with the right fake tokens,
history and alert files written, an 85% alert delivered, zero hits for either fake token in the data folder, the fake HOME,
stdout and stderr including every IPC payload), Playwright screenshots and the browser smoke test in Chrome.

CI (build, tests, screenshots) passes on Windows, Linux and macOS, and the release installers were installed and started in an
automated smoke test on all three systems (Linux on x86_64 only). That test does not click the tray icon.

**Not verified:**

- Windows and Linux by hand: tray behaviour, autostart, notifications, credential locations, window placement, the Linux
  AppIndicator tray, the Windows `taskkill` tree kill, the `.cmd` shim path, Windows credential and home-folder precedence and
  the Windows program lookup.
- The real usage endpoints of either tool (never called by the author).
- The macOS Keychain (not supported).

## Differences from the Mac bar

- No Keychain: **on macOS the native Python usage bar is the supported path**; this build reads only a credentials file. The
  tray shows text only on macOS (Windows and Linux show the icon and a tooltip).
- Glass and blur only soften what is inside the popup (a webview cannot blur your desktop). The settings are still stored.
- Numbers come from the response directly instead of parsing text rows; labels are the same (`5h limit`, `Weekly limit`,
  and the model-specific weekly and 5-hour rows). A limit that is nearly used up (99.6% used) reads `0% left` because "left" is rounded down on
  purpose (conservative): 0.5% used reads 99% left, and 100% left is shown only when nothing is used.
- Reset texts (only used when a provider sends text instead of a time) are computed with the platform time-zone database; for a
  few instants around daylight-saving changes (checked for America/Vancouver) the result can differ by an hour from the Mac bar's
  Python result (cause not determined: the two may resolve the same ambiguous or skipped local time differently). Real responses
  carry absolute times, where there is no difference.
- Mac-model quirks kept: a numeric string or boolean passed to the state / delay functions is read like Python's `float()` /
  `int()`. Arabic-Indic digits in reset text ("resets ١٧:١٩") are not read (Python's `\d` accepts them).
- No "Open terminal" button; "Use a usage reset" opens the usage page in the browser (you press the button there).
- Only the two supported tools are covered, as on the Mac.

## Known gaps

- Windows has no inode and its file "ctime" is the creation time, so the save-conflict check cannot notice an outside edit that
  keeps both the size and the modification time of `settings.json`. A changed size or time is noticed. The app's own saves are
  never affected.
- Linux tray icons cannot report clicks; use the tray menu "Show Usage Bar".
- No sign-in flow and no token refresh: sign in again with the CLI when the app says so.
- The 7-day history and the alert state are per computer.

## Releasing

Releases are built by `.github/workflows/release.yml` when a version tag is pushed. The builds are unsigned (see the release
notes text in that file). Expect small fixes on the first public release.

1. Choose the new version, for example `0.2.0`, and change it in all three places so they match: `version` in
   `src-tauri/tauri.conf.json`, `version` in `src-tauri/Cargo.toml`, and `version` in `package.json`. Then run `cargo check` in
   `src-tauri` (and `npm install --package-lock-only`) so `Cargo.lock` and `package-lock.json` follow.
2. Commit the change, then tag it: `git tag v0.2.0`. The tag must be `v` plus the exact version; the workflow stops with an
   error if it differs from `tauri.conf.json` or if the three versions disagree.
3. Push the commit and the tag: `git push` and `git push origin v0.2.0`.
4. Open the repository on GitHub, then Actions, and wait for the `release` run (macOS Apple silicon and Intel, Windows, Linux).
5. Go to Releases, open the new draft, check that every installer is attached, read the notes, and click Publish release.
   Delete the draft and the tag if something is wrong.
