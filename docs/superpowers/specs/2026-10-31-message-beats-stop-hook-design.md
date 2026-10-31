---
id: 2026-10-31-message-beats-stop-hook-design
title: A message goes ahead of a running Stop hook
type: spec
status: active
domain: server
related:
  - 2026-09-24-streaming-output-design
tags:
  - sessions
  - hooks
---

# A message goes ahead of a running Stop hook

A project can configure a `Stop` hook: a command the CLI runs when the agent
has finished its answer, before the turn ends. A verification gate (typecheck,
tests) is the usual one, and it can run for minutes; the CLI's default timeout
is long enough for a hook to hold a turn for five.

While it runs, an Orbital session looks broken:

- The answer is complete on screen, and nothing says anything is still
  running. Orbital does not ask the SDK for hook events, so it does not know.
- A message written now shows as a sent bubble, but the CLI only queues it
  until the turn ends. Several messages pile up under the answer, unanswered.
- Stop cancels the hook, the turn ends, and the CLI then runs the queued
  messages as a new turn. The session "starts by itself".

Seen on a real project: three answers in a row each waited the full five
minutes behind a gate that timed out, in a conversation that changed no code.

## What changes

### A message cancels a running Stop hook

When the user sends a message to a session whose main loop has finished its
answer and is only running `Stop` hooks, Orbital interrupts the turn right
after handing the message to the CLI. The interrupt cancels the hook, the turn
ends, and the CLI picks the queued message up at once as the next turn.

This drops no check. The new message starts a turn, and the `Stop` hook runs
again when that turn ends, against the state that turn leaves. The run that was
cancelled was checking a state the user's message is about to change anyway.

Only `Stop` hooks of the main loop, and only while no other part of the turn
runs: a message sent while a tool or a model call runs is queued exactly as
today. `SubagentStop` and every other hook event are left alone.

Verified against CLI 2.1.280 through the SDK, the way the runner drives it:
with the message on stdin first and with the interrupt first, the CLI answers
the interrupt with a `cancelled` `hook_response`, the interrupt marker and the
turn's `result`, then runs the queued message as the next turn. The CLI's own
`session_state_changed` stays `running` across that `result`; the runner does
not rely on it and keeps the session `working` itself, the way a message sent
after a turn's end would. Which of the two reaches the CLI first is not fixed
(the SDK writes the prompt stream a tick behind a control request), so the
runner calls the interrupt right after the enqueue, which keeps messages in
the order they were sent. A second message in the same instant does not
interrupt again. A hook that ends on its own in exactly that instant could
let the interrupt land on the new turn; the SDK offers nothing to close it.

The same holds for every way a message reaches a session: the composer, the
phone, the control API (`orbital_act`), and a harness sending on the user's
account. They all go through `Runner.send`, and that is where the rule lives.

### The running hook is visible

Orbital asks the SDK for hook events (`includeHookEvents`). While a main-loop
`Stop` hook runs, a quiet notice sits under the transcript, where the
compaction block and the limit wait sit, and says what a message will do:

> Stop hook running — a message goes ahead of it

The SDK's hook events do not name the command: `hook_name` is the event itself
(`Stop`, which takes no matcher). So the notice names no hook; with several
running it reads "Stop hooks running". It shows only once a hook has run for
`STOP_HOOK_NOTICE_AFTER_MS`: most `Stop` hooks (a plugin's, say) end in
milliseconds, and a row for each would flash under every answer
(why-orbital → Nothing blinks). The send rule does not wait for it.

It disappears when the last hook ends (`hook_response`, any outcome), the turn
ends, the user interrupts, or a message cancels the hook. It carries no
ticking counter (why-orbital → Waiting is fine). It is live state, not
history: the runner publishes it on `session:<id>` as a `live_notice` event
carrying a notice row (`null` takes it down), drawn with the transcript's
notice row; it is not written anywhere and a reload does not rebuild it. A
client that selects the session while the hook runs sees no notice until the
next one.

Hooks of other events stay invisible, as they are today. They are short by
nature (a `PreToolUse` hook that runs for minutes is a broken hook), and a row
per tool call would be noise.

### The cancelled hook reads as such

The interrupt leaves the CLI's own `[Request interrupted by user]` line in the
transcript, after a `hook_cancelled` attachment for the `Stop` event. Shown
as-is it would say the user interrupted something they never stopped. Where
that line directly follows a cancelled `Stop` hook, the row is a notice that
reads "Stop hook cancelled" instead, live and on reload. On reload "directly
follows" is the chain: the marker's `parentUuid` is the `hook_cancelled`
attachment's. Live, the stream carries no attachment, only the `cancelled`
`hook_response` before the marker. That covers a press on
Stop during the hook as well, where the same words are just as true.

## Scope

- **Who it is for:** everyone whose project has a `Stop` hook — common in
  repositories set up for agents, and in plugins.
- **Where it lives:** on by default, no setting. A message already means "go
  on"; a hook that keeps it waiting is not something anyone chooses, and the
  check still runs on the turn that follows.
- **What someone notices after updating:** a message sent during a `Stop` hook
  is answered at once instead of after the hook; a notice under the answer
  while a `Stop` hook runs.
- **What can be set:** nothing.

Terminal sessions are shown, not driven: their hooks are the terminal's
business, and nothing here applies to them.

## Phone

Reaches the phone without phone work. A message from the phone goes through
the same `send` route and the same `Runner.send`, so it cancels the hook the
same way. The notice rides the session's WS topic as a `live_notice` event; the
phone draws it at the top of its transcript tail with the shared notice row,
and not while its Mac sleeps. An older phone does not know the event and
ignores it, so it shows nothing; the "Stop hook cancelled" row is an ordinary
notice row, which every phone already draws. No new route.

## Out of scope

- Making hooks run in the background. The CLI runs `Stop` hooks inside the
  turn, and their exit code can extend it; that is the CLI's contract.
- Pulling a queued message back into the composer on Stop. With the rule above
  a message no longer waits behind a hook, which is what made Stop surprising.
