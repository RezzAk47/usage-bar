# Usage Bar

[![CI](https://github.com/RezzAk47/usage-bar-cross/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RezzAk47/usage-bar-cross/actions/workflows/ci.yml)
![Platforms: Windows, Linux, macOS](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-informational)
![Version 0.1.1](https://img.shields.io/badge/version-0.1.1-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**See how much of your AI coding tool usage limits you have left, right in your tray.**

Usage Bar is a small tray / menu-bar app for Windows, Linux and macOS. It shows the 5-hour and weekly limits of your AI coding
tools as rings, warns you before you run out, counts down to the next reset and keeps a 7-day history. Built with Tauri 2
(Rust) and Preact.

| Light | Dark, with 7-day history |
|---|---|
| <img src="docs/popover-light.png" width="300" alt="Usage Bar popup in light mode with usage rings"> | <img src="docs/popover-dark.png" width="300" alt="Usage Bar popup in dark mode with usage rings and 7-day history"> |

<sub>Screenshots use made-up sample numbers.</sub>

Supported tools: Claude Code and Codex CLI.

## Features

- A ring and `N% left` for every limit, with an OK / Low / Critical chip and the time until it resets.
- The lowest limit in the tray (`63% left` next to the icon on macOS, a tooltip on every OS).
- Alerts at 80% and 95% used (both adjustable), once per limit and reset window.
- 7-day history sparkline per tool.
- Refresh every minute; a tool that fails is retried on its own and the last good numbers stay on screen.
- Light and dark, four layouts (Cards, Glass, Solid, Compact), colour themes, start at login, keyboard and screen-reader friendly.

## Download

Installers will be on the [Releases](https://github.com/RezzAk47/usage-bar-cross/releases) page (coming soon). Until then,
[build from source](#build-from-source).

The builds are not code-signed, so Windows SmartScreen and macOS Gatekeeper will warn the first time you open the app.

## Platform support

| | Windows | Linux | macOS |
|---|---|---|---|
| Installer (when released) | `.exe` (NSIS), x64 | `.deb` and `.AppImage`, x86_64 | `.dmg`, Apple silicon and Intel |
| CI build and tests | Passing | Passing | Passing |
| Installer smoke test (installs and starts) | Passing | Passing | Passing |
| Tested by hand | Not yet | Not yet | Yes |
| Text next to the tray icon | Tooltip only | Tooltip only | Yes |
| Open the popup | Click the tray icon | Tray menu, "Show Usage Bar" | Click the menu-bar icon |

On a Mac, the token in `~/.claude` is usually kept in the Keychain, which this app does not read, so those limits will not
show there. See [docs/DETAILS.md](docs/DETAILS.md#credentials-and-safety).

## Privacy

| What | Details |
|---|---|
| Reads | The sign-in token files your AI coding tools already keep: `~/.claude/.credentials.json` and `~/.codex/auth.json`. Read-only: never written, copied or logged. |
| Sends | Each token only to the service that issued it, over HTTPS, to ask how much of your limit is used: `api.anthropic.com` and `chatgpt.com`. No other host is allowed and redirects are refused. |
| Stores | `settings.json`, `usage-alerts.json`, `usage-history.json` and `usage-backoff.json` in the app's data folder on your computer. |
| Never | No analytics, no telemetry, no account, nothing sent to the author. The app's web view has no network access at all. |

**Read this before installing.** The two usage endpoints are **undocumented and unofficial**. They can change or stop working
at any time, and using CLI tokens with them may be outside what the providers' terms allow. You use this app at your own risk.
Usage Bar is an independent project, not affiliated with or endorsed by the makers of the supported tools. The full disclaimer,
the exact requests and how tokens are protected are in [docs/DETAILS.md](docs/DETAILS.md).

## Build from source

Needs Node 24+, Rust 1.90 or newer, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
system (on Linux: WebKitGTK 4.1 and an AppIndicator library, see `.github/workflows/ci.yml`).

```sh
git clone https://github.com/RezzAk47/usage-bar-cross.git
cd usage-bar-cross
npm ci --ignore-scripts
npm run tauri build          # installer for this OS, in src-tauri/target/release/bundle
npm run tauri dev            # or run it in development mode
```

Build with `npm run tauri build` (or `tauri dev`), not a plain `cargo build`: a plain cargo build does not embed the page and
the window never starts.

Tests:

```sh
npm test && npx tsc --noEmit
(cd src-tauri && cargo test --locked && cargo clippy --all-targets -- -D warnings)
```

More checks (UI smoke test, screenshots, token-leak run) are listed in [docs/DETAILS.md](docs/DETAILS.md#all-checks).

## Status

Early (v0.1.1). Developed and used on macOS. CI passes on Windows, Linux and macOS, and the installers install and start in an
automated test on all three, but nobody has used the Windows or Linux builds by hand yet. The real usage endpoints have not
been called by the author; everything is tested against fake servers. Known gaps and differences from the Mac usage bar are
in [docs/DETAILS.md](docs/DETAILS.md#known-gaps).

## Credits

Based on [CLI-Usage](https://github.com/nimaansari/CLI-Usage) by Nima Ansari (MIT). His licence notice is in
[NOTICE-CLI-Usage.md](NOTICE-CLI-Usage.md). Thank you, Nima. The Tauri, Rust and Preact code here is a separate
implementation written from the Mac bar's behaviour and tests.

Third-party components and trademark notes: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (full licence texts in
[THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt)).

## License

MIT. See [LICENSE](LICENSE).

## Contact

Questions or a security problem: rzk.karimi@gmail.com (see [SECURITY.md](SECURITY.md)). Please do not post tokens or
screenshots with account details in public issues.
