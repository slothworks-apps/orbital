---
id: a-message-waits-for-a-stop-hook
title: A message waits for a running Stop hook; cancelling it is the user's press
status: in-force
type: adr
domain: server
related:
  - 2026-10-31-message-beats-stop-hook-design
tags:
  - sessions
  - hooks
---
# A message waits for a running Stop hook; cancelling it is the user's press

## Context

A project's `Stop` hooks run after the agent has finished its answer, inside
the turn. The CLI queues a message sent meanwhile until they end, which can
take minutes behind a test or typecheck gate. The first version of the spec
(#174) had Orbital interrupt the turn on every such send, so the message went
ahead of the hook at once.

A hook can write, not only check: a formatter, `git commit`, a deploy step.
Interrupted partway, it can leave the tree half-formatted or a
`.git/index.lock` behind. Orbital cannot tell a hook that checks from one that
writes; the SDK's hook events do not even name the command.

## Decision

A message sent while `Stop` hooks run waits for them, as in the CLI. The live
"Stop hook running" row carries a Cancel, which sends the session's interrupt;
the runner takes an interrupt while only the main loop's `Stop` hooks run for
cancelling them, and a waiting message is then answered at once. No setting.

## Alternatives

- **Cancel on send, by default** (the first version): fastest when the hook
  only checks, but it changes what a message does without the user choosing
  it (why-orbital → An update changes nothing you did not choose), and it
  breaks hooks that write.
- **A setting to cancel on send**: the user still has to know, once and for
  every project, whether all their hooks are safe to stop. The press on the
  row is made when they know.

## Consequences

- An Orbital session behaves like the CLI by default; going ahead of a hook
  is one press on the row that says it runs, on the Mac and the phone.
- Cancel needs no new route: it is the interrupt the phone may already send.
- A hook that ends in the instant Cancel is pressed can let the interrupt land
  on the next turn; the SDK offers nothing to close it.
