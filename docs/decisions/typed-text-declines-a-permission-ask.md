---
id: typed-text-declines-a-permission-ask
title: Composer text declines a parked permission ask, never approves it
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-permission-and-plan-decisions-design
  - 2026-09-20-interactive-decisions-design
tags:
  - runner
  - detail-panel
---
# Composer text declines a parked permission ask, never approves it

## The problem

While a decision is parked, the composer cannot start a turn — the CLI
is blocked inside `canUseTool` and has no stdin to read a turn from. The
question card already settled what typing means there: the words ARE the
free-form answer (spec `2026-09-20-interactive-decisions-design`).

A permission prompt and a plan approval take no words. Something still
has to happen when someone types into the composer and presses ⏎.

Three options were on the table: ignore the text, approve with the text
attached, or decline with the text as the reason.

## The decision

Typed text **declines** the ask, with the text as the message the model
reads back. It enqueues no turn. `Runner.send()` branches on the parked
decision's `kind` to do it, and the composer's hint and placeholder say
so before ⏎ is pressed.

## Why

**It is what the CLI already does.** Claude Code's permission prompt
offers *"No, and tell Claude what to do differently"*, and typing a
sentence is exactly the gesture that reaches for it. Someone typing
while a permission card is up is almost never saying "yes"; they are
saying "not that — do this".

**Nothing may be approved by a keystroke.** The same rule that puts
Decline first in the tab order and refuses a one-key approve applies
here. An approval path that a stray ⏎ in a focused composer can reach is
the one outcome this surface must not have.

**Ignoring it is a silent failure.** Text that vanishes, or sits in the
box doing nothing while the session stays parked, reads as a broken app.

## The bug this replaced

Before the branch, `send()` settled ANY parked decision as
`{behavior: 'allow', updatedInput: {...input, answers}}` — written when
`question` was the only kind that could be parked. Reaching a permission
ask, it would have merged an `answers` key into the tool's own input
**and allowed it**: typing "no, don't" into the composer would have run
the command. The kind check in `send()` is that fix; the route's
kind-aware body validation is the second line of the same defence.

## What we give up

There is no way to approve from the keyboard alone without first tabbing
to the button. Accepted: the asymmetry is the point.
