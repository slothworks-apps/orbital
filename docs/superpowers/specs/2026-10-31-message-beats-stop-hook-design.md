---
id: 2026-10-31-message-beats-stop-hook-design
title: A running Stop hook shows, and can be cancelled
type: spec
status: done
domain: server
related:
  - 2026-09-24-streaming-output-design
tags:
  - sessions
  - hooks
---

# A running Stop hook shows, and can be cancelled

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

### A message waits; Cancel goes ahead

A message sent while the main loop has finished its answer and only `Stop`
hooks run waits for them, as in the CLI: the runner hands it to the CLI, which
queues it until the turn ends. Orbital does not cancel the hooks by itself —
a hook can write (a formatter, a commit), and only the user knows whether
theirs is safe to stop (ADR `a-message-waits-for-a-stop-hook`).

The live notice below carries a **Cancel**. It sends the session's interrupt,
the same request as Stop. While the notice is up and only `Stop` hooks of the
main loop run, the runner takes that interrupt for cancelling them:

- with a message waiting behind the hooks, the turn ends and the CLI picks the
  message up at once as the next turn. The `Stop` hook runs again when that
  turn ends, against the state it leaves, so no check is dropped;
- with no message waiting, the turn simply ends.

An interrupt before the notice is up is an ordinary Stop: a hook that young
may already have ended without saying so.

Verified against CLI 2.1.280 through the SDK, the way the runner drives it:
the CLI answers the interrupt with a `cancelled` `hook_response`, the interrupt
marker and the turn's `result`, then runs a queued message as the next turn.
The CLI's own `session_state_changed` stays `running` across that `result`; the
runner does not rely on it and keeps the session `working` itself, and
publishes `working` again on the handover so a crash in the message's turn is
still seen as one. To the turn-end callbacks (the harness, the titler) the
cancelled turn and the message's are one turn: the cancelled `result` fires no
turn end, so a harness does not spend its step there and the next real end
stays paired with the start before both. A CLI that sent no `result` for the
cancelled turn hands over at the message's first answer instead. A hook that
ends on its own in the instant Cancel is pressed could let the interrupt land
on the new turn; the SDK offers nothing to close it.

Only `Stop` hooks of the main loop, and only while no other part of the turn
runs: an interrupt while a tool or a model call runs stops the turn as today.
`SubagentStop` and every other hook event are left alone. A `Stop` hook whose
`hook_response` never comes is let go when the model answers again, since no
`Stop` hook can still run once it does.

### The running hook is visible

Orbital asks the SDK for hook events (`includeHookEvents`). While a main-loop
`Stop` hook runs, a quiet notice sits under the transcript, where the
compaction block and the limit wait sit:

> Stop hook running · **Cancel**

Once the user sends a message behind it, it reads "Stop hook running — your
message waits for it" ("…them" for several).

The SDK's hook events do not name the command: `hook_name` is the event itself
(`Stop`, which takes no matcher). So the notice names no hook; with several
running it reads "Stop hooks running". It shows only once a hook has run for
`STOP_HOOK_NOTICE_AFTER_MS`: most `Stop` hooks (a plugin's, say) end in
milliseconds, and a row for each would flash under every answer
(why-orbital → Nothing blinks).

It disappears when the last hook ends (`hook_response`, any outcome), the turn
ends, or the user cancels or interrupts. It carries no
ticking counter (why-orbital → Waiting is fine). It is live state, not
history: the runner publishes it on `session:<id>` as a `live_notice` event
carrying a notice row (`null` takes it down), drawn with the transcript's
notice row; it is not written anywhere and a reload does not rebuild it. A
client that selects the session while the hook runs sees no notice until the
next one. A client draws the notice only while the session reads `working`,
and drops it on `turn_result`, on a `sessions`-topic status other than
`working`, when it lets go of the session's topic, and on reconnect, so an
end it did not hear cannot leave the row under a finished answer. While it is
up, it is republished as hooks start and end, so its count stays right.

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
- **Where it lives:** on by default, no setting. Sending keeps the CLI's
  behaviour; going ahead of the hook is the user's choice each time, on the
  row that says the hook runs.
- **What someone notices after updating:** a notice under the answer while a
  `Stop` hook runs, with a Cancel that ends the hook and answers a waiting
  message at once.
- **What can be set:** nothing.

Terminal sessions are shown, not driven: their hooks are the terminal's
business, and nothing here applies to them.

## Phone

Built for the phone too. The notice rides the session's WS topic as a
`live_notice` event; the phone draws it at the top of its transcript tail with
the shared notice row and a compact Cancel, and not while its Mac sleeps.
Cancel is the existing interrupt route, already on the phone's allowlist, so a
phone works against every Mac that sends the notice; a Mac too old to send it
shows nothing to cancel. An older phone does not know the event and
ignores it, so it shows nothing; the "Stop hook cancelled" row is an ordinary
notice row, which every phone already draws. No new route.

## Out of scope

- Making hooks run in the background. The CLI runs `Stop` hooks inside the
  turn, and their exit code can extend it; that is the CLI's contract.
- Pulling a queued message back into the composer on Stop.
- Cancelling the hooks on send, as a setting: weighed and left out (ADR
  `a-message-waits-for-a-stop-hook`).
