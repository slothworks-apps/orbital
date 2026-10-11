---
id: phone-reads-a-sessions-terminals
title: The phone shows the output of a session's terminals, read-only
status: backlog
type: idea
domain: remote
related:
  - 2026-10-05-embedded-terminal-design
tags:
  - mobile
  - terminal
---
# The phone shows the output of a session's terminals, read-only

The embedded terminal ([[2026-10-05-embedded-terminal-design]]) is left out
of the phone on purpose. Typing into a shell on a phone keyboard is poor work,
and a live shell on the Mac is a larger power than a paired phone holds today.

Reading is a different matter. Away from the desk, the useful question is
whether the dev server is still up or the test run has finished, and the
terminal's output answers it.

It would take:

- `GET /api/sessions/:id/terminals` on the allowlist in
  `server/src/remote/allowlist.ts`;
- a read-only way to get the output through the relay: the scrollback buffer on
  request, or a stream that carries output and nothing back;
- a view in `web/src/mobile` that renders it without a keyboard.

Nothing typed on the phone should reach the shell, so the write half of
`/ws/terminal/:id` never goes through the relay.
