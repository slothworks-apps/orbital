---
id: notice-rows-are-their-own-kind-of-turn
title: A locally-answered slash command is a notice row, not an assistant turn
type: adr
status: in-force
domain: transcripts
related:
  - locally-answered-slash-commands
  - context-usage-has-one-source
  - 2026-09-18-transcript-folding-design
tags:
  - slash-commands
  - transcripts
---

# A locally-answered slash command is a notice row, not an assistant turn

## The problem

`/context`, `/usage`, `/mcp`, `/agents`, `/status` and `/permissions` are
answered by the CLI itself, without the model. On the SDK stream that answer
arrives as an **assistant** frame whose `message.model` is the literal
`<synthetic>`, whose `usage` is all zeros, and which carries the output a
second time in a `local_command_source` sibling
(domain `locally-answered-slash-commands`).

The pump already handled `type: 'assistant'`, so the output *was* published
while the session was live — but as an assistant turn, with three
consequences:

1. `<synthetic>` reached the transcript as a model, so `insertModelDividers`
   drew `FABLE 5.1 → <SYNTHETIC>` above every local command and a second
   divider back below it.
2. The zero `usage` was captured as `lastCall`, the context arc's fallback
   reading for the turn — a measurement of nothing, allowed to stand in for a
   real one.
3. The whole of `/context`'s output went to the auto-titler as assistant prose.

And on **reload it vanished entirely**. The CLI does not write these to the
transcript file as turns; it writes them as `system`/`local_command` entries,
which `entriesToMessages` dropped along with every other non-turn entry. A
session that had shown its `/context` output a minute earlier showed nothing
after a refresh, and a terminal session — which Orbital only ever reads from
the file — never showed it at all.

So the two paths did not merely render the answer differently. One rendered it
wrongly and the other not at all.

## What was decided

**A fifth `ChatMessage` role: `notice`.** It carries `text`, and
`notice: { level, command? }`. It is the CLI speaking for itself: no model, no
turn, nothing that went to or came from the API.

Both paths build it, through one module (`server/src/transcript/notices.ts`):
the pump recognises the synthetic frame by `local_command_source` and diverts
it *before* the usage capture, `onEntries` and the ordinary publish; the parser
recognises `system`/`local_command` in the file. Live and reloaded transcripts
now show the same row for the same command.

**A new role rather than a flag on the assistant role.** A flag would have left
every consumer that switches on `role` — the titler, the model-divider pass,
the pairing — correct only by remembering to check it. A role they do not know
is one they already ignore, which is the behaviour each of them wants.

**The row is verbatim, never markdown.** This follows the folded command
expansion in `MessageView`, which made the same call for the same reason:
"it's a file, not speech". `/context` prints a pipe table that a markdown
renderer reflows into something narrower and harder to read, `/usage` prints
lines that markdown joins into a paragraph, and an older CLI prints ANSI-
coloured box drawing that is not markdown at all. One `<pre>` handles all
three, with ANSI decoded the way a Bash tool result's is.

**Bounded height, not a fold.** `/context` is dozens of lines and would
otherwise swallow the transcript, but a row that has to be opened before it
says anything is the silence this change exists to end. It scrolls inside the
same 168px box the expansion `<pre>` uses.

**The structured twins are not read.** `/context` carries `context_usage` and
`/usage` carries `usage_report`, and the SDK calls the text the canonical form
and the twins a convenience for clients rendering a card. Orbital renders no
such card yet. The arc keeps its single source — the `get_context_usage`
control request the turn's `result` already triggers (adr
`context-usage-has-one-source`) — rather than gaining a second one that only
`/context` turns would feed.

## What was ruled out

**Leaving the live path as an assistant turn and fixing only the reload.** It
would have kept the three defects above and still left the two paths
disagreeing about what kind of row this is.

**Treating `system`/`local_command_output` as the mechanism.** A parity audit
named it as the reason these commands looked silent. It is a real subtype in
`SDKMessage`, but none of the six emits it on CLI 2.1.278; the synthetic
assistant frame does all the work. It is handled anyway, along with
`system`/`informational`, because both are in the union and both genuinely fell
through the pump unread.

**Rendering the transcript file's command echo as a notice.** For `/status` and
`/permissions` that echo is the only record of what was typed, and calling it
machine output would have hidden the question while showing the answer. It
comes back as the `user` row it is.

## What follows from it

Any future `system` subtype that carries user-facing text has one place to be
added — `noticeFromSdkMessage` — and reaches the transcript without touching
the pump's control flow. Everything else about `system` messages is unchanged:
the subtypes the pump does not name still fall through unread.
