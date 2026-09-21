---
id: run-the-desktop-app
title: Run the Orbital desktop app
type: runbook
status: in-force
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
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
