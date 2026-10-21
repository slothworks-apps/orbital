---
id: taking-over-a-terminal-session-ends-its-cli
title: Taking over a terminal session ends its CLI
type: adr
status: in-force
domain: sessions
related:
  - 2026-10-21-take-over-terminal-session-design
---
# Taking over a terminal session ends its CLI

## Context

A session a terminal CLI holds was read-only in Orbital, and an Orbital
session resumed in a terminal showed controls the server then refused.
`why-orbital` → Terminal sessions are shown, not driven: Orbital does not
drive a terminal session.

## Decision

Orbital offers **Take over** on a session a terminal holds. It ends the CLI
process (`SIGTERM`, then `SIGKILL`), and Orbital's own process if one still
idles beside it, and the session becomes an Orbital session, which the next
message resumes from the transcript. `why-orbital` → Terminal sessions are
shown, not driven names it as the one exception. Until then the session stays
read-only, its row's `source` notwithstanding.

This does not drive the terminal session; it ends it and moves the
conversation into Orbital, which is what Orbital is for. Nothing the CLI
does is mirrored.

## Alternatives

- **Only lock the controls** while a terminal holds the session. It fixes
  the refused controls but leaves the user to find the terminal and quit it
  by hand.
- **Take over on any write** — a message or a mode switch ends the CLI
  first. Ruled out: a message, possibly sent from the phone, would end a
  process someone may be typing into, with no deliberate step.
