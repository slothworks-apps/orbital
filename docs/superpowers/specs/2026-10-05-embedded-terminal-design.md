---
id: 2026-10-05-embedded-terminal-design
title: A terminal inside Orbital, in the session's directory
status: draft
type: spec
domain: sessions
related:
  - why-orbital
  - feature-parity-with-the-claude-code-cli
  - 2026-09-16-electron-wrapper-design
  - phone-reads-a-sessions-terminals
tags:
  - terminal
  - desktop
---
# A terminal inside Orbital, in the session's directory

Orbital is meant to replace the CLI, yet the work around an agent still sends
you to a terminal: `git status`, running the tests yourself, starting the dev
server you want to look at. This puts that terminal inside Orbital, next to the
session it belongs to, so that switching apps is not part of the work.

The terminal is **yours, not the agent's**. What you run in it does not reach
the session's context; Claude does not see it. Sending a command's output to
Claude is the CLI's `!` shell mode, a separate gap listed in
[[feature-parity-with-the-claude-code-cli]] and not part of this spec.

## What it is

- A terminal belongs to a session and starts in the session's `cwd`.
- A session can have several terminals, as tabs: one holding a dev server and
  one for commands is the common case.
- Terminal sessions (the ones Orbital only watches) get terminals too. All a
  terminal needs is a `cwd`, and every session has one.
- A shell lives until you end it. Closing the panel or reloading the window
  does not end it; coming back finds the shell, its scrollback and whatever is
  still running in it. This is [[why-orbital]]'s "nothing ends behind your
  back".
- A shell does not survive a restart of Orbital. Keeping it would need tmux
  underneath (see *Ruled out*), and nothing asked for it.

## Server

A new module, `server/src/terminal/`, owns the running shells. It is the only
place that spawns or kills one.

### Routes

- `POST /api/sessions/:id/terminals` spawns the user's shell (`$SHELL -l`, a
  login shell, so `.zprofile` and its nvm setup are loaded) in the session's
  `cwd` through `node-pty`, and returns the terminal's `id`.
- `GET /api/sessions/:id/terminals` lists the session's terminals and whether
  each is still running, with the exit code when it is not. The window rebuilds
  its tabs from this after a reload.
- `DELETE /api/terminals/:id` closes a terminal: the shell's whole process
  group gets `SIGHUP`, so a dev server started in it ends with it. A terminal
  whose process already exited is simply forgotten.

A session that does not exist is a `404`, as in every other session route.

### The shell's environment

The shell inherits the server's environment minus what Orbital set for itself:
the API token and every `ORBITAL_*` variable. Your commands should not see
Orbital's internals, and an `ORBITAL_*` variable leaking into a test run is
known to break things (two server tests fail under it today).

### Scrollback

Each terminal keeps the most recent output in a ring buffer in memory, capped
by a named constant in the module. A socket that attaches gets the buffer first
and the live stream after it. Nothing is written to the database: the shell
does not outlive the server, so neither should its history.

### When a terminal ends

| what happens | what happens to the shell | what the tab shows |
|---|---|---|
| `exit`, or the shell dies | already gone | stays, marked as exited with its code, until you close it |
| you close the tab | process group gets `SIGHUP` | gone |
| you end the session (`POST /api/sessions/:id/end`) | every terminal of the session is closed | gone |
| Orbital quits | the server closes every terminal on shutdown | — |

The last row matters most: a dev server orphaned by a quit Orbital would hold
its port with nothing left to stop it.

## Transport

Each terminal has its own WebSocket, `/ws/terminal/:id`, next to the existing
`/ws`. Keystrokes go in and output comes out as raw bytes. The only other
messages are a resize from the window and an exit notice from the server.
Keeping it off `/ws` means a `cat` of a large file does not queue up behind, or
in front of, the map's events.

A terminal is a full shell, so every guard the API has applies, none of them
optional:

- the token from `<dataDir>/api-token`, exactly as `/api` and `/ws` require it;
- the Origin check `/ws` uses (`isAllowedWsOrigin` in `server/src/index.ts`),
  so a foreign page cannot open the socket;
- the server binds to `127.0.0.1` only, as it already does.

## Web

- A `TerminalView` component wraps `xterm.js` with its fit addon (the terminal
  follows the size of its container and reports the new size to the server)
  and its web-links addon (a URL in the output, such as the dev server's
  `localhost` address, opens through the desktop's existing external-link
  handling).
- The session's terminal tabs live in a zustand store. Opening a session loads
  `GET /api/sessions/:id/terminals` and reattaches to the running ones.
- While a terminal has focus it receives every key, `Ctrl-C` and `Esc`
  included. Orbital's own shortcuts are suspended except the window's ⌘
  shortcuts. This is verified in Electron on a Czech QWERTZ keyboard.
- The terminal's colours come from the canvas palette.

### Look and placement

Where the terminal sits (a dock at the bottom of the detail panel, a panel of
its own, something else) and how its tabs look is decided in Claude Design, not
here. The design brief carries these constraints:

- several tabs per session, and a way to open a new one;
- an exited terminal that stays until it is closed, with its exit code;
- [[why-orbital]]'s calm: no blinking, no unread-output counters, no badge for
  a terminal that printed something while you looked elsewhere.

## Phone

**Left out, on purpose.** Neither `/ws/terminal/:id` nor the terminal routes go
on the allowlist in `server/src/remote/allowlist.ts`, so nothing of this
reaches the relay.

Typing into a shell on a phone keyboard is poor work, and a live shell on the
Mac is a larger power to hand to a paired phone than anything it holds today.
Reading a terminal's output from the phone (has the dev server crashed?) is
worth doing later; it is written down as [[phone-reads-a-sessions-terminals]].

## Packaging

`node-pty` is a native addon. It ships beside the server the way
`better-sqlite3` does (`desktop/electron-builder.yml`), with only the
darwin-arm64 build and its `spawn-helper` binary, which has to stay
executable.

The server runs in Electron's `utilityProcess`, so the addon is loaded by
Electron's Node. `node-pty` is built on N-API, which should make it load
without an Electron-specific rebuild. This is the main technical risk of the
feature and is verified on a packaged DMG before anything else is built on top.

## Tests

- The terminal module: a shell starts in the session's `cwd`; a reattaching
  socket gets the scrollback before the live stream; closing a terminal ends a
  child process started in it; ending a session closes its terminals; the
  shell's environment carries no `ORBITAL_*` variable and no token.
- The security boundary: `/ws/terminal/:id` refuses a missing or wrong token
  and a foreign Origin; no terminal route passes the phone allowlist.
- Nothing on how `xterm.js` renders.

## Ruled out

- **The shell in Electron's main process, over IPC.** It saves the trip through
  the server, but the main process is meant to stay thin, and it would not work
  in the browser during `npm run dev`.
- **tmux underneath.** Shells would survive a restart of Orbital, at the cost of
  a dependency on tmux being installed. Nothing asked for that survival.
- **Opening an external terminal app in the session's directory.** Smaller, but
  it sends you out of Orbital, which is what this exists to stop.

## Not in scope

- Sending a command's output to the session (`!` shell mode).
- Terminals not tied to a session.
- Shells that survive a restart of Orbital.
