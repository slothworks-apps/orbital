---
id: an-approved-plan-continues-in-acceptedits
title: An approved plan continues in acceptEdits, with no mode to choose
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-permission-and-plan-decisions-design
  - permission-prompts-write-no-permission-rules
tags:
  - runner
  - agent-sdk
---
# An approved plan continues in acceptEdits, with no mode to choose

## The problem

Approving `ExitPlanMode` has to take the session out of plan mode —
otherwise the CLI stays read-only and the approved plan cannot run a
step of itself. `Query.setPermissionMode(mode)` does it, and the mode is
a parameter: something has to pick one.

Claude Code's own prompt offers two continuations: *"Yes, and
auto-accept edits"* (`acceptEdits`) and *"Yes, and manually approve
edits"* (`default`).

## The decision

An approved plan always continues in **`acceptEdits`**. The verdict
carries no mode, the card offers no choice, and the route accepts none.

## Why

**Orbital's mode vocabulary has no `default`.** `PermissionMode` in
`server/src/types.ts` is `plan | acceptEdits | auto | bypassPermissions`
— the SDK's `default` and `dontAsk` were deliberately left out (spec
`2026-09-17-permission-mode-dots-design`). Adding `default` is not a
one-line widening: it is a fifth card in the launch picker, a fifth dot
hue, a row in the settings column, a change to artboards 2d/2e, and two
tests that pin the list. That is a design change, and there is no
canvas for it.

**`acceptEdits` is no longer a blank cheque.** It was, before this
change: with no permission surface at all, "asks before shell commands"
meant those commands died. Now the same change that opens this dead end
also gives the session a permission card, so an `acceptEdits` session
edits freely and still stops on every shell command. That is very close
to what "manually approve edits" was for, one step further along.

**Offering the choice with only one real option is worse than not
offering it.** A two-button approval where one button leads somewhere
the type system cannot express would be a menu with a broken entry.

## What we give up

A user who wants an approved plan to keep asking about file edits, not
only about shell commands. They can decline the plan and say so, or end
the session and relaunch — both worse than a button.

## Revisit when

`default` earns a place in the picker on its own merits — which this
change makes more likely, since an ask-about-everything mode is only
useful once there is something to ask with. At that point the plan
approval becomes two buttons and the verdict grows a `mode` field
restricted to `default | acceptEdits`; `auto` and `bypassPermissions`
must stay unreachable from here, since approving one plan is not
consent to run unattended.
