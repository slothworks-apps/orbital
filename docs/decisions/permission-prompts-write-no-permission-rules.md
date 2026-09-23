---
id: permission-prompts-write-no-permission-rules
title: Orbital's permission prompt offers allow-once only, never "always allow"
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-permission-and-plan-decisions-design
tags:
  - runner
  - agent-sdk
  - security
---
# Orbital's permission prompt offers allow-once only, never "always allow"

## The problem

The SDK hands the host everything it needs for a don't-ask-again button.
`canUseTool`'s options carry `suggestions: PermissionUpdate[]` — "the
full set of suggestions to return as `updatedPermissions` if you present
the user an option 'always allow' or similar" — and a
`PermissionResult` that echoes them back writes those rules. Each
`PermissionUpdate` names a `destination`: `userSettings`,
`projectSettings`, `localSettings`, `session` or `cliArg`.

Orbital now has a permission card. Two buttons on it is one fewer than
the CLI offers, and the missing one is the one people press most.

## The decision

The card offers **Allow once** and **Decline**, and returns no
`updatedPermissions`. The SDK field is not passed through and the
suggestions are not carried on the pending decision at all.

## Why

**Three of the five destinations are files on disk that outlive the
session.** `userSettings`, `projectSettings` and `localSettings` write
into `~/.claude` and into the repository's own settings — the same files
the CLI reads on every future run, in this project and others. A click
in Orbital would silently change what a terminal session does tomorrow.

**Orbital has no authentication.** The server binds to `127.0.0.1` and
there is no login; any process on the machine that can reach the port
can POST to the decision endpoint. Allow-once is bounded by the tool
call in front of it — the blast radius is one command the model was
already about to run. A rule written to `userSettings` is not bounded by
anything.

**The SDK itself says which asks may not offer it.** The callback
carries `suppressAlwaysAllowRule` ("the rule it would write grants more
than this ask's own action") and `defaultToNo`, and honouring them
correctly is part of the feature, not an extra. Shipping the button
without that machinery would be shipping the unsafe half.

**There is no design for it.** There is no artboard for the permission
card at all, let alone for scoping a rule to a destination. A
don't-ask-again button whose scope the user cannot see is the worst
version of this feature.

## What we give up

Repetition. A session that runs twenty shell commands asks twenty
times. The pressure valve already exists and is explicit: the launch
picker's `acceptEdits`, `auto` and `bypassPermissions` modes, chosen
per session with their consequences written next to them — and
`~/.claude`'s own `permissions.allow` rules, edited where such rules
have always lived.

## Revisit when

There is an artboard that shows the scope of the rule being written, and
the card honours `suppressAlwaysAllowRule`. The natural first step is
`destination: 'session'` alone — a rule that dies with the session and
cannot reach a file — with the settings-file destinations still out.
