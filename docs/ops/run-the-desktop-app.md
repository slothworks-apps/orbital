---
id: run-the-desktop-app
title: Run the Orbital desktop app
type: runbook
status: in-force
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - trim-and-sign-the-desktop-package
tags:
  - desktop
  - electron
---
# Run the Orbital desktop app

The `desktop/` workspace is the Electron shell. It never starts `tsx` or
`vite` — it either attaches to a server that already answers on the port, or
forks the built server bundle itself.

## Attached mode (development, HMR)

```bash
npm run dev            # terminal 1: server on 4737 + vite on 5173
npm run dev:desktop    # terminal 2: builds desktop/dist, then `electron .`
```

The window loads `http://127.0.0.1:5173`. The probe finds the dev server and
attaches: no child is forked, and quitting the app leaves your `npm run dev`
running.

If nothing answers on the port, dev mode does **not** fork a server — it says
so in a dialog and quits. Start `npm run dev` first.

## Forked mode (what the packaged app does)

```bash
npm run build -w server     # server/dist/index.mjs
npm run build -w web        # web/dist, served by the server itself
npm run build -w desktop    # desktop/dist/main.cjs + preload.cjs
cd desktop && npx electron .
```

The window loads the server's own origin, so the built frontend and the API
are same-origin and neither `api.ts` nor `ws.ts` needs a base URL.

The child is forked with `ORBITAL_RESOLVE_PATH=1`, `ORBITAL_STATIC_DIR` and
`ORBITAL_MIGRATIONS_DIR`. The last one is not optional: the bundle's default
migrations path is resolved relative to its source module, so it is wrong the
moment the server is bundled.

### Do not collide with your own dev server

`npx electron .` on the default port attaches to a running `npm run dev`
instead of forking. To exercise the fork path, give it a port and a scratch
database:

```bash
cd desktop
ORBITAL_PORT=4791 \
  ORBITAL_DATA_DIR=$(mktemp -d) \
  ORBITAL_CLAUDE_DIR=$(mktemp -d) \
  npx electron .
```

## Package the DMG

```bash
npm run desktop:dist        # from the repo root, always
```

The artifact lands in `desktop/release/` as `Orbital-<version>-arm64.dmg`,
beside its `.blockmap` and the unpacked `mac-arm64/Orbital.app`.

**Run it from the root, not from the workspace.** `npm run dist -w desktop`
builds only the desktop workspace and then packages whatever happens to be
sitting in `server/dist` and `web/dist` — stale output, or a build that fails
outright on `extraResources` when those directories do not exist yet. The root
script exists because it builds the server and the web app first.

### After a `node_modules` wipe: Electron's binary is missing

This machine's npm policy does not run install scripts it has not been told to
allow, and Electron downloads its own binary in a postinstall. After any
reinstall, `node_modules/electron/dist` is absent and packaging fails. Run the
postinstall by hand:

```bash
node node_modules/electron/install.js
```

The other skipped install scripts are harmless: `better-sqlite3` ships a
Node-API prebuild that is what gets packaged anyway, `electron-winstaller` is
never reached on a `--mac` build, and the esbuild copies that matter were
installed with the workspaces.

## First launch on another Mac

The DMG is unsigned (spec §4 step 1 — signing and notarization come later), so
Gatekeeper quarantines it. On the first launch the user must **right-click the
app → Open** and confirm, rather than double-clicking it. If macOS refuses even
that, clear the attribute directly:

```bash
xattr -d com.apple.quarantine /Applications/Orbital.app
```

Notifications also need permission once. An unsigned app may not produce the
system prompt, in which case enable Orbital under **System Settings →
Notifications** before running the smoke test below — with notifications off,
the app behaves exactly as if nothing were ever newsworthy.

**Smoke-test the packaged app from outside this repo.** Copy the `.app` to
`/Applications` or a temp directory first. Left inside `desktop/release/`, it
sits under the repo's own `node_modules`, which still holds the ~208 MB
`@anthropic-ai/claude-agent-sdk-darwin-arm64` package that packaging
deliberately excludes — a resolution that walked up to it would make a
packaging regression look like a success.

## Smoke test: notifications and click-through

Not unit-testable — it needs a human to see a banner and click it.

1. Open the app and move focus elsewhere (another window, or Finder). A focused
   window suppresses notifications by design.
2. Drive one session from `working` to `needs_input`. Easiest is to spawn a
   session from the map and let its turn end; a terminal session hitting a
   permission prompt does the same.
3. **Exactly one** macOS notification appears, bodied *"Needs your input"* and
   titled with the session's name.
4. Click it. The window raises **and** that session is selected: the detail
   panel opens and `?session=<id>` appears in the URL.
5. Let the same session emit the same status again. **No second notification** —
   a repeat of a state already seen is not news.

## What notifies, and what does not

Decided against the statuses the registry actually produces, and implemented in
`desktop/src/lib/notifications.ts` as a fold over transitions, never over
states.

Notifies:

| transition | notification |
|---|---|
| `working → needs_input` | "Needs your input" |
| `working → ended` | "Session ended" |
| `session_failed` on the `errors` topic | "Session failed: …" |

A turn ending, a permission prompt and an `AskUserQuestion` all arrive as the
same `working → needs_input` transition, so all three notify and none can be
distinguished from the others. Terminal sessions are included: the CLI's
`waiting` state maps to `needs_input`, so their turn ends notify too.

Silent by design:

- **The first sighting of a session**, whatever its status. The server replays
  nothing on subscribe, but a registry rescan re-emits every live session, so a
  rule keyed on a state rather than a transition would fire on every reconnect.
- **A repeat of a status already seen.**
- **`idle → ended`** — that is the ageing timer, not a session finishing.
- **Any transition out of `idle`**, including `idle → needs_input`.
- **`remove`**, which is how terminal sessions leave.

## Checks

- `curl -s http://127.0.0.1:<port>/api/health` → `{"app":"orbital",…}`.
- `lsof -nP -i :<port> -sTCP:LISTEN` after quitting: empty if the app forked
  the server, still listening if it attached to yours.

## When something goes wrong

| symptom | cause |
|---|---|
| "Orbital’s server did not start" | `server/dist/index.mjs` missing or stale — run `npm run build -w server`. The server's own output goes to the terminal that launched Electron. |
| `Can't find meta/_journal.json` in that output | the fork lost `ORBITAL_MIGRATIONS_DIR`. |
| "Port … is taken" | something that is not Orbital answers there. Stop it or set `ORBITAL_PORT`. |
| A blank window in forked mode | `web/dist` is missing — run `npm run build -w web`. |
| "The Claude Code CLI was not found" | expected when no CLI is on the resolved PATH. Pick the executable; the app PATCHes `claude_executable_path` and restarts the server, because that setting is read once at boot. |
| `npm run desktop:dist` fails on a missing Electron binary | `node_modules/electron/dist` was never downloaded — run `node node_modules/electron/install.js`. |
| No notification ever appears | the window was focused (suppression is correct), or Orbital is not permitted in System Settings → Notifications. |
| A notification for something you did not expect to be news | check the transition, not the status — the rules are the table above. |
