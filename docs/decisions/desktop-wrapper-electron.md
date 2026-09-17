---
id: desktop-wrapper-electron
title: Ship Orbital as an Electron app, not Tauri or Electrobun
status: in-force
type: adr
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
tags:
  - packaging
  - desktop
---
# Ship Orbital as an Electron app, not Tauri or Electrobun

## The problem

Orbital runs as two processes started by hand: `npm run dev` brings up the
Fastify server on `127.0.0.1:4737` and a Vite dev server on `5173`, and you
open a browser tab. It should instead be a real macOS application — one icon,
one launch, native notifications you can click back into.

Target is macOS only for now, arm64, for two users. Other desktop platforms
should stay possible but are explicitly not on the roadmap. No app stores. A
signed DMG and a Homebrew cask are wanted eventually; an Apple Developer
account is available.

## What constrains the choice

The backend is not incidental to this decision. `server` is a Node application
that:

- loads `better-sqlite3`, a native module, through `drizzle-orm/better-sqlite3`
- spawns the Claude Code CLI as a child process via
  `@anthropic-ai/claude-agent-sdk`
- watches `~/.claude` with `chokidar`

The frontend is a WebGL space map built on `three` + `@react-three/fiber`, with
`drei` `<Html>` labels anchored to each planet.

So any wrapper must host a Node-compatible runtime with native modules and
subprocess spawning, and must render a non-trivial WebGL scene well.

## What we decided

**Electron.**

The deciding argument is not size or speed. It is that Tauri, Wails and
Neutralino all pay for their small binaries by replacing the backend language —
and Orbital's backend has to stay JavaScript. Node would ship as a sidecar
anyway, so their central advantage never arrives while their costs (a second
toolchain, a non-Chromium webview) all do.

NW.js is Electron's older equivalent with a fraction of the ecosystem and
weaker signing and release tooling. A hand-written Swift + WKWebView shell
would give the best native behaviour and the smallest binary, at the price of
an Xcode project in an otherwise TypeScript repo, no path to other platforms,
and hand-rolling everything `electron-builder` provides. A PWA or launchd agent
cannot own the server lifecycle or deliver clickable notifications.

## What we measured on Electron

Observed directly, Electron 44.4.1 (bundled Node 24.21.0):

- `node:sqlite` works in both the main process and under
  `ELECTRON_RUN_AS_NODE`, unflagged and without an experimental warning.
- It is nevertheless **not** usable here: `drizzle-orm@0.45.2` — which is both
  the installed and the latest version — ships no `node:sqlite` adapter. Its
  SQLite adapters are `better-sqlite3`, `bun-sqlite`, `durable-sqlite`,
  `expo-sqlite`, `op-sqlite` and `sqlite-proxy`.
- `better-sqlite3@13.0.3` loads in Electron **unchanged, with no
  `@electron/rebuild` step**. Its prebuilds are keyed by platform only
  (`prebuilds/darwin-arm64.node`), not by ABI version — the N-API layout, which
  is binary-stable across Node and Electron. Electron reports
  `modules 149` against Node's own ABI and still loads it.

The rebuild step an earlier draft of this decision assumed is therefore not
needed. The only packaging consequence is that `.node` files must be unpacked
from the asar archive, since native libraries cannot be loaded from inside one.

## What we measured on Electrobun

Electrobun was the one alternative worth a real investigation: a Zig shell over
WKWebView with a Bun backend, so JavaScript on both sides without a bundled
Chromium. A timeboxed spike (2026-09-16, throwaway code outside this repo)
returned GO-WITH-CAVEATS on the technology and a clear no against Orbital's
requirements.

What worked:

- Orbital's real schema and real `drizzle/` migration folder, running an exact
  mirror of `openDb()`, passed **unmodified** under Bun — `better-sqlite3`,
  drizzle, the migrator, `.pragma()` and a 500-row transaction — inside a built
  Electrobun `.app`.
- `@anthropic-ai/claude-agent-sdk` spawns its CLI correctly under Bun, and does
  so structurally rather than by luck: the SDK's `getDefaultExecutable()`
  branches on `process.versions.bun`, and the CLI now ships as a native
  per-platform binary that is spawned directly. It succeeded with
  `PATH=/usr/bin:/bin`, with neither node nor bun reachable.
- Bundle size 20–65 MB against Electron's ~180 MB, plus working codesign,
  notarization, DMG and delta auto-update.

What ruled it out:

- **Clicking a notification does nothing.** `Utils.showNotification` displays a
  notification, but the click callback is unimplemented (upstream issue #384,
  open since 2026-04). Click-through from a notification back into the app is
  the single feature the user cares most about.
- `better-sqlite3@13.0.3` hard-panics Bun 1.4.0 — `panic(main thread): NAPI
  FATAL ERROR` — and Electrobun 2.0.1 defaults to exactly Bun 1.4.0. Bisected
  clean from 1.4.1 up. The version can be pinned via `build.bun.version`, but
  that key is absent from the published `ElectrobunConfig` type: undocumented
  surface the whole app would rest on.
- WKWebView is capped at 60Hz rAF against Chromium's 120, and is roughly 2×
  slower on the pure WebGL path. The collapse is specifically on drei `<Html>`
  labels — Orbital's actual architecture: at 2000 planets WebKit fell to 0.1
  fps with individual frames of 19–47 seconds, where Chromium held 50.8.
  Realistic session counts are fine; the headroom is not.
- macOS arm64 only, no cross-compilation, closing the door on other platforms
  rather than leaving it ajar.
- One maintainer holds ~96% of ~2,450 commits, and the README states there
  should be no expectation that pull requests are reviewed or merged. Never
  reached 1.0. On a clean install, `hutch electrobun init` was deadlocked
  between toolchain versions and the default `mainProcess: "cottontail"` build
  failed on a file missing from a published release.

Reasoned rather than observed, and flagged as such: the notification
click-through gap and the global-shortcut weakness were both read from source
and upstream issues, not executed. Safari 26.6.2 stood in for WKWebView in the
rendering benchmark.

## Consequences

- The app will be large: ~180 MB of Electron. The Claude CLI is not bundled —
  see [[2026-09-16-electron-wrapper-design]] — which keeps it off the ~400 MB
  it would otherwise reach.
- Chromium in the renderer means the space map runs on the same engine it is
  already developed and tested against.
- `better-sqlite3` and the entire server stack stay exactly as they are.
- A Bun migration is not required and not pursued. Should one ever be wanted
  for other reasons, the spike establishes that the server survives Bun ≥ 1.4.1
  unchanged.
- Global shortcuts, a tray item and `orbital://` deep links are all available
  in Electron when wanted. None is in the first version.
