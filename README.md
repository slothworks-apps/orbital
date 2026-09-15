# Orbital

Orbital is a local web app that visualizes and manages your Claude Code
sessions as a 2D space map: sessions are planets, subagents are orbiting
moons. It shows live terminal sessions (read-only) alongside full session
history, lets you organize sessions with tags and auto-tag rules, and can
spawn and drive its own sessions through the Claude Agent SDK — a full chat
with Claude from the browser, including resuming and continuing historical
sessions. It runs only on your own machine, binds to `127.0.0.1`, and has no
authentication.

## Screenshot

![Orbital map view](docs/screenshot.png)

*(placeholder — capture after first run and drop the file at `docs/screenshot.png`)*

## Prerequisites

- Node.js 20+
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

This is a single npm workspace covering both `server` and `web`.

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

## Test

```bash
npm test -w server        # server test suite (Vitest)
npm run test:run -w web   # web test suite (Vitest + Testing Library), single run
npm run test -w web       # web test suite in watch mode
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
