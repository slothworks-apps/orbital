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
- **Where it lives:** on by default, chosen on purpose rather than Labs: it
  fixes the reported bug, and it does nothing until pressed. The session
  stays read-only until the user presses **Take over**; nothing happens to a
  terminal on its own.
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
   `source`; only the shape reports the terminal. Its status is the
   terminal's too, ahead of an Orbital process that may still idle beside it
   (the registry never lists Orbital's own processes).
2. **Take over.** The read-only bar carries a **Take over** button. Pressed,
   Orbital ends the CLI process that holds the session, and the session
   becomes Orbital's: `source: web`, not ended, no process. It reads `idle`,
   and the next message resumes it in Orbital, as for any sleeping session.
   Orbital's own process, if one still idles beside the terminal, is stopped
   too: it holds the conversation as it was before the terminal's turns, and
   a message sent into it would fork the transcript.
   A session with no conversation yet (a CLI that has not taken a first
   message, so no transcript and no row) offers no Take over.
3. **A busy terminal asks first.** On the Mac, Take over opens a confirm
   whenever the CLI is not plainly `idle`: a turn running there, or a
   question it waits on, stops. An idle CLI is taken over at once. On the
   phone it always asks, as End does: someone may be typing into that
   terminal at the Mac.
4. **How the CLI is ended.** `SIGTERM`, then `SIGKILL` if it is still alive
   after a grace period. Only the pid the registry lists for that session,
   only if no other session's entry names the same pid, and only if that
   process is still a `claude` process — a stale registry file whose pid was
   reused never gets another process killed; it is deleted instead. The
   CLI's registry file is deleted after the take over, since a killed CLI
   leaves it behind. If a process will not die, the route answers 504 and
   the row is put back.
5. **A terminal leaving an Orbital session.** When the registry drops a
   session whose row is `source: web` — after a take over, or a terminal
   that resumed an Orbital session and exited — the session is republished,
   not removed: it is Orbital's, asleep.

The terminal itself is left as it is: its CLI exits, its shell stays.

### Server

`POST /api/sessions/:id/take-over`:

- The row is flipped to `source: web`, `endedAt: null` first, before any
  signal: the CLI deletes its registry file as it exits, and the watcher may
  hear that before the route does; its remove then republishes the session
  instead of taking it off the map.
- 404 for an unknown session.
- 504 `still_running` when the CLI outlived `SIGKILL`, or Orbital's own
  process would not stop; the row is put back.
- 200 `{ ok: true }` otherwise — also when no terminal holds the session any
  more (it let go first) or the entry was stale — once both processes are
  gone and the registry has been rescanned.

## The phone

Built for the phone too. The ⋯ menu of a live terminal session gets a
**Take over** row next to its read-only note, which always asks first
(§ 3). The route goes on the allowlist, and the row is
gated in `MAC_FEATURES` as `takeOver`: against a Mac older than the release
that serves it, the row is left out. A phone taking over a session ends a
process on the Mac; that is the same reach End already has, behind the same
pairing.

## Edge cases

- **The terminal exits on its own between the press and the kill.** The
  route finds no registry entry and takes the session over all the same:
  the user asked for it to go on in Orbital.
- **Two terminals on one session.** The registry keys by session id and
  keeps one entry; after the take over the rescan shows the other, and the
  session stays read-only. Take over again ends that one.
- **A terminal session not indexed yet** (no row): no Take over is offered;
  the route answers 404 if called.

## Tests

- Route: the row flipped before the signal; Orbital's process stopped; a
  session nobody holds taken over; a stale or shared pid never signalled and
  its file dropped; the row put back on 504.
- `endCli`: SIGKILL after the grace, a reused pid never signalled, and which
  command lines read as a CLI.
- Shape: a `source: web` row the registry lists reads `source: terminal`,
  with the terminal's status.
- Registry remove: a `source: web` row is republished, a `source: terminal`
  row is removed.
- Phone menu: `takeover` for a live terminal session on a Mac that serves
  it, not on an older Mac, not for an ended one, not before a first
  message.

## Design brief for Claude Design

The read-only bar under a live terminal session (desktop 1b composer
slot, "runs in terminal — read-only") gains one action, **Take over**. It
must not compete with the transcript: the session is still someone else's
until it is pressed. A confirm, when the terminal is not idle, says
that what runs there stops. On the phone, a **Take over** row in the ⋯
sheet of a terminal session (canvas 10j Terminal menu), above its
read-only note, which now says the session can be taken over instead of
"end or clear it there".

Until Claude Design draws it, the build uses the existing primitives: a
small `Button` inside the read-only bar, a `Dialog` for the confirm, and a
`Row` with a `ConfirmBody` on the phone.
