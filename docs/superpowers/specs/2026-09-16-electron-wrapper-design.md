---
id: 2026-09-16-electron-wrapper-design
title: Orbital as a macOS desktop app — design
status: done
type: spec
domain: desktop
related:
  - desktop-wrapper-electron
  - 2026-09-15-orbital-design
tags:
  - packaging
  - desktop
  - electron
---
# Orbital as a macOS desktop app — design

**Date:** 2026-09-16
**Wrapper choice and the evidence behind it:** [[desktop-wrapper-electron]]

## Goal

Turn Orbital from two hand-started processes and a browser tab into one macOS
application. First version: a window, and native notifications that can be
clicked to jump back to the session they are about.

Scope boundaries, decided with the user:

- macOS arm64 only. Other platforms stay possible, none is targeted.
- No app stores. Unsigned DMG now; signing, notarization and a Homebrew cask
  later, using an Apple Developer account that already exists.
- No auto-update in the first version.
- A tray item, `orbital://` deep links and a global shortcut are wanted
  eventually. None is built now, and none constrains this design.

## 1. Process architecture and lifecycle

Three roles:

- **Electron main process** — owns the window, notifications, and the server's
  lifecycle.
- **Server** — today's Fastify server, started as an Electron
  `utilityProcess.fork()` child. Its own lifecycle, its own message port.
- **Renderer** — today's web app, unchanged.

### The window loads `http://127.0.0.1:4737`, not a `file://` URL

This is forced by how the web client addresses the backend. It builds URLs
relative to the page origin — `new URL('/api/sessions', window.location.origin)`
at `web/src/lib/api.ts:56`, and the WebSocket defaults to the path `'/ws'` at
`web/src/lib/ws.ts:37`. Loaded from `file://`, `window.location.origin` is the
string `"null"`: every fetch breaks, and the WebSocket handshake sends
`Origin: null`, which `isAllowedWsOrigin` in `server/src/index.ts` rejects
because it is a present-but-unlisted origin.

Serving the built frontend from Fastify keeps everything same-origin. Both
existing guards — `isAllowedHost` and `isAllowedWsOrigin` — keep working
exactly as written, and neither `api.ts` nor `ws.ts` is touched.

The cost is one server addition: `@fastify/static`, serving `web/dist` in
production. Development is unaffected; Vite on `5173` keeps proxying `/api` and
`/ws` as configured in `web/vite.config.ts`.

In development the window points at `127.0.0.1:5173` instead. That is
same-origin for the same reason — the Vite proxy puts `/api` and `/ws` on that
origin — and it keeps HMR working. See section 4.

### Startup: the app yields to a server that is already running

The main process probes `127.0.0.1:4737` before doing anything else.

- **Something answers as Orbital** — attach to it. Do not fork a server.
- **Nothing answers** — fork the server, wait for ready, then open the window.

Identifying "as Orbital" needs a dedicated `GET /api/health` endpoint.
Inferring it from `/api/settings` is brittle and would misread any unrelated
service occupying the port.

This is what makes the app and `npm run dev` share one database and one
watcher, which is the behaviour the user chose over separate data directories
or separate ports.

### Shutdown: kill only what we started

If the app forked the server, it stops it on quit. If it attached to a server
that was already running, it leaves it alone — otherwise quitting the app would
kill the user's own `npm run dev`.

### The server dying is a designed state

When the child process exits unexpectedly, the main process catches it and the
renderer shows a "server stopped" state with a restart action. Never a blank
window.

### Closing the window

In the first version, closing the window quits the app. When the tray item
lands, closing becomes hiding — that is the point at which "close" and "quit"
have to separate, and it is deliberately deferred.

That point came: see `2026-09-22-desktop-background-mode-design`.

## 2. Build and packaging

### A new `desktop/` workspace

Alongside `server` and `web`, holding the main process, the preload script and
the `electron-builder` configuration. The existing workspaces keep their shape.

### The server needs a build step, and has none

`server/tsconfig.json` sets `noEmit: true`; the only way the server currently
runs is `tsx watch src/index.ts`. Add an esbuild bundle step producing a single
file, with two mandatory externals:

- **`better-sqlite3`** — a native binding; it cannot be bundled.
- **`@anthropic-ai/claude-agent-sdk`** — it resolves paths at runtime.
  `server/src/runner/version.ts` calls
  `require.resolve('@anthropic-ai/claude-agent-sdk')` and reads `manifest.json`
  from the resulting directory. Bundling breaks that resolution.

### One forced source change: the migrations folder

`server/src/db/database.ts:12` resolves migrations as
`fileURLToPath(new URL('../../drizzle', import.meta.url))` — relative to the
module. Once the module is bundled elsewhere, that path is wrong.

Make the migrations folder a parameter of `openDb`, defaulting to today's
value. Development and the existing test suite see no change; the packaged app
passes the path to its unpacked resources.

This keeps the user's requirement that migrations run at startup satisfied by
the mechanism that already satisfies it: `openDb` runs the drizzle migrator on
every open, and the `DEFAULT_SETTINGS` seed covers newly added settings keys.
No second migration framework is introduced.

A migration that fails must surface as a visible error state, for the same
reason a dead server does.

### Unpacked from asar

Three things cannot live inside the asar archive:

- `better-sqlite3`'s `prebuilds/darwin-arm64.node` — native libraries cannot be
  loaded from an asar.
- the `drizzle/` folder of SQL migrations.
- any executable that must be spawned.

### The Claude CLI is not bundled

`@anthropic-ai/claude-agent-sdk-darwin-arm64` is 201 MB — the native `claude`
binary the SDK spawns. It is an `optionalDependencies` entry of the SDK, so
excluding it from the package is a `files` exclusion in `electron-builder`; it
stays present in development.

Orbital already requires an installed, logged-in Claude Code CLI (see the
README) because it reads that CLI's transcripts from `~/.claude`. Bundling a
second copy would mean Orbital *reads* transcripts written by the user's CLI
while *writing* them with a different version. Using the user's own CLI keeps
one version of the format on both sides, and keeps the app off ~400 MB.

The SDK supports this directly: `pathToClaudeCodeExecutable?: string`
(`sdk.d.ts:1840`, "Path to the Claude Code executable. Uses the built-in
executable if not specified."). Options are assembled in one place,
`server/src/runner/runner.ts:239`, and `queryFn` is already injectable for
tests.

### Target

`arm64` only. A universal build doubles everything for an Intel Mac neither
user has.

## 3. Process environment and macOS integration

### PATH: the consequence of not bundling the CLI

An app launched from Finder does not inherit a login shell's `PATH`. It gets
roughly `/usr/bin:/bin:/usr/sbin:/sbin`. The user's `claude` is almost
certainly not there — `~/.local/bin` and `/opt/homebrew/bin` are the common
locations.

This is not only about finding the CLI. Sessions Orbital spawns run tools
inside themselves; a session that cannot find `git` or `npm` is useless.

Both are solved in one place: **at startup the server resolves the real PATH
once** — by running the user's login shell and reading it back — and assigns it
to its own `process.env.PATH`. Everything it spawns inherits it, the CLI and
every tool inside a session alike. Nothing needs to be threaded through the SDK.

Two safeguards:

- Login shells can be slow (nvm and similar). Resolution runs with a timeout
  and falls back to a list of known locations.
- A `claude_executable_path` key in the `settings` table: empty means
  autodetect, a value overrides. This follows the existing pattern beside
  `default_permission_mode`, and the Settings panel already exists.

The server's environment is already load-bearing, and this work writes to it.
`server/src/index.ts:91` deletes `ANTHROPIC_API_KEY` from `process.env` at
startup unless `ORBITAL_USE_API_KEY=1`, which is what forces spawned sessions
onto CLI OAuth and the user's subscription rather than pay-per-token API
billing. Rewriting `PATH` happens beside that deletion and must not disturb
it — the packaged app inherits its environment from Finder or `launchd`, where
a stray `ANTHROPIC_API_KEY` is just as possible as in a shell.

### A missing CLI is a designed state

The app opens, reports that it could not find the Claude Code CLI, and offers
to pick the path. Not a map on which spawning sessions silently fails.

### `resolveClaudeCodeVersion()` has to change

It currently reads the version from the bundled SDK manifest
(`server/src/runner/version.ts`). That manifest will not be shipped, and even
if it were it would name a version that is not the one being spawned. It must
instead report the version of the CLI that actually runs.

### Notifications and click-through

Electron's `Notification` with its `click` event. The main process opens a
WebSocket to `/ws` and subscribes to the `sessions` topic — the same contract
the web app uses, rather than a private side channel. This passes the origin
guard as written: a non-browser client sends no `Origin`, and
`isAllowedWsOrigin` admits those.

A click does two things: raises the window, and selects the session the
notification is about. The second half already exists —
`web/src/lib/sessionUrl.ts` keeps the selected session in the URL, so the click
handler sets that URL.

Which events warrant a notification (session ended, session failed, session
waiting on a permission prompt) is to be fixed in the implementation plan
against the statuses `SessionRegistry` actually produces, rather than asserted
here.

### First version scope

Window, plus notifications with click-through. The tray item needs only the
close-versus-quit decision; deep links need an `Info.plist` entry and the same
handler the notification click already uses.

## 4. Distribution, migrations, testing

### Distribution, in three steps

1. **Now** — `electron-builder` produces an unsigned `arm64` DMG. Gatekeeper
   requires right-click → Open on first launch. Sufficient for two users.
2. **Later** — signing and notarization through the existing Apple Developer
   account. Configuration, not rearchitecture; `electron-builder` has it built
   in and nothing in this design changes.
3. **Last** — a Homebrew cask, in a tap repository, pointing at the DMG in
   GitHub Releases. Only worth doing after signing: a cask over an unsigned app
   hits the same quarantine problem.

No auto-update in the first version. It was not asked for, it requires signing,
and `electron-updater` can be added later without touching the architecture.

### Migrations

Already handled, and deliberately not extended. `openDb` runs the drizzle
migrator on every open and seeds `DEFAULT_SETTINGS`, which covers new settings
keys. The only work is the migrations-folder path change in section 2, plus
making a failed migration visible.

### Testing

Electron is awkward to test, so logic must not live in it. Every decision
belongs in plain functions under `desktop/src/` that Vitest can exercise
without launching Electron:

- parsing a PATH out of a login shell's output
- locating `claude` within a given PATH, and honouring the settings override
- deciding whether Orbital is already listening on `4737`
- translating a socket event into a notification and a click target

The Electron shell around them stays thin and decision-free.

What cannot be unit tested — that the `.app` actually launches, that clicking a
notification actually switches session — is a manual smoke test, written down
as a `runbook` under `docs/ops/` rather than improvised each time.

### Development workflow

`npm run dev` is unchanged. A new `npm run dev -w desktop` opens an Electron
window pointed at `127.0.0.1:5173`; the port probe finds the running dev server
and attaches to it, so HMR keeps working. The packaged app forks its own server
and points at `4737`. One code path, two modes.

## Open questions

None blocking. Two items are deferred to the implementation plan by design:
the exact set of session events that trigger a notification, and the precise
fallback list of `claude` install locations.
