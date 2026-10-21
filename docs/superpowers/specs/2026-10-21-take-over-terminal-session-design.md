---
id: 2026-10-21-take-over-terminal-session-design
title: Take over — move a session a terminal holds into Orbital
type: spec
status: done
domain: sessions
related:
  - a-session-a-terminal-resumed-cannot-be-ended-or-switched
  - taking-over-a-terminal-session-ends-its-cli
  - reviving-a-terminal-session-leaves-it-read-only
tags:
  - registry
  - mobile
---
# Take over — move a session a terminal holds into Orbital

## The problem

A session a terminal CLI holds is read-only in Orbital. That is right while
someone works in that terminal, but it is a dead end once they want to go on
in Orbital: the only way out is to find the terminal and quit the CLI by
hand.

It is also broken for a session Orbital started and a terminal then resumed
(`claude --resume <id>`). Its row stays `source: web`, so the client offers
the mode switcher, the composer and End, and the server refuses or ignores
them (fix `a-session-a-terminal-resumed-cannot-be-ended-or-switched`). When
that CLI exits, the session drops off the map, though it is Orbital's.

## Scope

- **For:** anyone who starts a session in a terminal and later wants to go
  on in Orbital, and anyone who resumed an Orbital session in a terminal.
  Moving off the terminal is what Orbital is for (`why-orbital` → What it is
  for: replacing the CLI).
- **Where it lives:** on by default, as an option beside the old behaviour.
  The session stays read-only until the user presses **Take over**; nothing
  happens to a terminal on its own.
- **What an existing user notices after updating:**
  - A **Take over** button in the read-only bar of a session a terminal
    holds, and a **Take over** row in the phone's ⋯ menu of that session.
  - An Orbital session resumed in a terminal now reads as read-only while
    the terminal holds it, instead of showing controls that do nothing.
  - Such a session stays on the map when its terminal exits, instead of
    disappearing.
- **What can be set:** nothing.

## Behaviour

1. **Who holds a session.** A session the terminal registry lists is shown
   as a terminal session (`source: terminal` in the API shape), whatever
   its row says. The composer, the mode and model switchers, End and Clear
   are locked, as for any live terminal session. The row keeps its own
   `source`; only the shape reports the terminal.
2. **Take over.** The read-only bar carries a **Take over** button. Pressed,
   Orbital ends the CLI process that holds the session, and the session
   becomes Orbital's: `source: web`, not ended, no process. It reads `idle`,
   and the next message resumes it in Orbital, as for any sleeping session.
   If Orbital's own process still holds the session, it goes on.
3. **A working terminal asks first.** When the terminal's CLI is working
   (`status: working`), Take over opens a confirm: the turn running in the
   terminal stops. An idle or waiting CLI is taken over at once: nothing is
   lost.
4. **How the CLI is ended.** `SIGTERM`, then `SIGKILL` if it is still alive
   after a grace period. Only the pid the registry lists for that session,
   and only if that process is still a `claude` process — a stale registry
   file whose pid was reused never gets an unrelated process killed. If the
   process will not die, the route answers 504 and nothing changes.
5. **A terminal leaving an Orbital session.** When the registry drops a
   session whose row is `source: web` — after a take over, or a terminal
   that resumed an Orbital session and exited — the session is republished,
   not removed: it is Orbital's, asleep.

The terminal itself is left as it is: its CLI exits, its shell stays.

### Server

`POST /api/sessions/:id/take-over`:

- 404 for an unknown session.
- 409 `not_in_terminal` when the registry does not list it.
- 409 `not_claude` when the listed pid is no longer a `claude` process.
- 504 `still_running` when the process outlived `SIGKILL`.
- 200 `{ ok: true }` once the process is gone, the row is `source: web`,
  `endedAt: null`, and the registry has been rescanned, so the published
  session no longer reads as the terminal's.

## The phone

Built for the phone too. The ⋯ menu of a live terminal session gets a
**Take over** row next to its read-only note; a working CLI gets the same
confirm as on the Mac. The route goes on the allowlist, and the row is
gated in `MAC_FEATURES` as `takeOver`: against a Mac older than the release
that serves it, the row is left out. A phone taking over a session ends a
process on the Mac; that is the same reach End already has, behind the same
pairing.

## Edge cases

- **The terminal exits on its own between the press and the kill.** The
  route finds no registry entry and answers 409; the client reads the
  republished session, which is no longer read-only.
- **Two terminals on one session.** The registry keys by session id and
  keeps one entry; after the take over the rescan shows the other, and the
  session stays read-only. Take over again ends that one.
- **A terminal session not indexed yet** (no row): 404. It is listed again
  once the transcript is indexed.

## Tests

- Route: 409 without a registry entry; the kill reaches only a `claude`
  pid; SIGKILL after the grace; 504 when the process survives; the row
  flipped to `source: web`, not ended.
- Shape: a `source: web` row the registry lists reads `source: terminal`.
- Registry remove: a `source: web` row is republished, a `source: terminal`
  row is removed.
- Phone menu: `takeover` for a live terminal session on a Mac that serves
  it, not on an older Mac, not for an ended one.

## Design brief for Claude Design

The read-only bar under a live terminal session (desktop 1b composer
slot, "runs in terminal — read-only") gains one action, **Take over**. It
must not compete with the transcript: the session is still someone else's
until it is pressed. A confirm, only when the terminal is mid-turn, says
that the running turn stops. On the phone, a **Take over** row in the ⋯
sheet of a terminal session (canvas 10j Terminal menu), above its
read-only note, which now says the session can be taken over instead of
"end or clear it there".

Until Claude Design draws it, the build uses the existing primitives: a
small `Button` inside the read-only bar, a `Dialog` for the confirm, and a
`Row` with a `ConfirmBody` on the phone.
