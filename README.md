# Orbital

Orbital is a local web app that visualizes and manages your Claude Code
sessions as a 2D space map: sessions are planets, subagents are orbiting
moons. It shows live terminal sessions (read-only) alongside full session
history, lets you organize sessions with tags and auto-tag rules, and can
spawn and drive its own sessions through the Claude Agent SDK — a full chat
with Claude from the browser, including resuming and continuing historical
sessions. It runs only on your own machine, binds to `127.0.0.1`, and has no
authentication.

Moons appear only around sessions Orbital started itself. A terminal session's
transcript records a subagent only once it has finished, so there is no moment
at which its running subagents can be read —
[`docs/domains/subagents-in-transcripts.md`](docs/domains/subagents-in-transcripts.md)
has the measurements.

## Screenshot

![Orbital map view](docs/screenshot.png)

*(placeholder — capture after first run and drop the file at `docs/screenshot.png`)*

## Prerequisites

- Node.js 22+
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed
  and logged in. Orbital's web sessions run through the Claude Agent SDK and
  bill your Claude subscription via the CLI's own OAuth session — not an API
  key (see [Billing](#billing) below).
- A `~/.claude` directory populated by normal Claude Code CLI use (Orbital
  reads its project/session transcripts from there; see
  [A note on `~/.claude`](#a-note-on-claude) below).

## Install

```bash
npm install
```

This is a single npm workspace covering `server`, `web` and `desktop`.

## Run

Orbital is two processes: the server (API + WebSocket + the process that
watches `~/.claude` and drives spawned sessions) and the web frontend (Vite
dev server, which proxies `/api` and `/ws` to the server).

Start both with one command:

```bash
npm run dev             # server (http://127.0.0.1:4737) + web (http://127.0.0.1:5173)
```

Or each in its own terminal:

```bash
npm run dev:server
npm run dev:web
```

Open `http://localhost:5173`.

## Desktop app (macOS)

The `desktop/` workspace wraps the same web app in an Electron shell: one
window, and native macOS notifications that you can click to jump straight back
to the session they are about. It never starts `tsx` or `vite` — it either
attaches to an Orbital server that is already answering on the port, or forks
the built server bundle itself, so the app and a running `npm run dev` share
one database and one watcher instead of fighting over them.

In development, with `npm run dev` already running in another terminal:

```bash
npm run dev -w desktop   # window at http://127.0.0.1:5173, HMR intact
```

To build the installable app:

```bash
npm run desktop:release     # → desktop/release/Orbital-<version>-arm64.dmg
```

Always run that from the repo root: it builds the server and the web app first,
where `npm run dist -w desktop` on its own would package whatever stale output
happens to be lying in `server/dist` and `web/dist`.

macOS arm64 only, and the DMG is unsigned. On first launch the Mac will
quarantine it, so open it with **right-click → Open** rather than a
double-click, and enable Orbital under **System Settings → Notifications** if
macOS never offers the permission prompt by itself.

The packaged app does **not** bundle a Claude Code CLI — it spawns the one
already installed on the Mac, so that the CLI writing transcripts and the
Orbital reading them are the same version (and so the app stays ~200 MB
smaller). It resolves your real `PATH` at startup to find it; if autodetection
picks the wrong one, the `claude_executable_path` setting overrides it.

[`docs/ops/run-the-desktop-app.md`](docs/ops/run-the-desktop-app.md) has the
forked-mode recipe, the notification smoke test and the troubleshooting table.

## Test

```bash
npm test -w server        # server test suite (Vitest)
npm run test:run -w web   # web test suite (Vitest + Testing Library), single run
npm run test -w web       # web test suite in watch mode
npm test -w desktop       # desktop test suite (Vitest, no Electron launched)
npm test                  # all three, in order
```

Type checking and the production web build:

```bash
npm run typecheck -w server
npm run typecheck -w web
npm run build -w web
```

## Billing

A session you spawn or continue from Orbital's web UI runs through the
Claude Agent SDK, which prefers `ANTHROPIC_API_KEY` over CLI OAuth when the
key is present in the environment. Since Orbital's whole point is to drive
sessions billed against your existing Claude subscription (the same way the
CLI itself does) rather than pay-per-token API billing, the server **deletes
`ANTHROPIC_API_KEY` from its own environment on startup** unless you
explicitly opt in:

```bash
ORBITAL_USE_API_KEY=1 npm run dev:server
```

Only set that if you actually want spawned sessions billed to an API key
instead of your subscription.

## A note on `~/.claude`

Orbital reads and writes Claude Code CLI's on-disk state under `~/.claude`
(project transcripts, session `.jsonl` files, etc.) to build its session
list and live-tail running sessions. **These formats are undocumented,
internal details of the Claude Code CLI, not a public/stable API.** They can
change — or break Orbital — without notice when you update the CLI. If
Orbital stops seeing sessions after a CLI update, that's the likely cause.
