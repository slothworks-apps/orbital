---
id: models-come-from-the-sdk
title: The model list and its context window come from the SDK, not from a table
status: active
type: adr
domain: sessions
related:
  - 2026-09-16-agent-model-design
tags:
  - models
---
# The model list and its context window come from the SDK, not from a table

## The problem

`Feature - Agent model.dc.html` names four models — Fable, Opus, Sonnet,
Haiku — with versions (`Opus 4.1`, `Sonnet 4.5`) and cost/speed lines
(`SLOWEST · $$$$`). Every one of those strings was stale before the feature
was built: the SDK on the machine the canvas was drawn on already served
Opus 5, Sonnet 5 and a 1M-context variant. A model table in Orbital's source
is a table that is wrong within weeks and wrong silently.

The same applies to the context window. `DetailPanel.tsx` divided every
session's token usage by a hard-coded `200_000`. For a session running
`claude-opus-5[1m]` that bar was wrong by 5×, and it looked exactly as
confident as a right one.

## What was decided

**The list is read from `Query.supportedModels()`.** A dedicated probe —
`query()` whose prompt stream never yields, so no user message is ever sent
and no tokens are spent — asks the SDK and closes. `GET /api/models` serves
the last good list from `settings.models_catalog` immediately and refreshes
behind the request; only a cold first run waits.

Rejected: probing at boot (spawns a CLI on every restart even when nobody
opens the dialog, and a new model needs a restart to appear), and piggybacking
on a live session's query object (the New session dialog needs the list
*before* the first session exists, so it would still need a hard-coded seed —
the very thing being avoided).

**The context window is learned from `result.modelUsage[…].contextWindow`**
and stored per model. Rejected: parsing `"Opus 5 with 1M context · …"` out of
the SDK's `description`. That text is prose whose format can change without
notice, and the failure mode is a wrong number rather than a missing one.

**A fresh install has run no turns, so it has learned nothing** — and a
header reading `Opus 5 (1M)` above a bar drawn against an invented 200k is a
worse lie than a missing bar. `shapeModels` resolves `contextWindow` in
order: the learned value for the exact `resolvedModel`, else a small seed of
documented figures keyed by the id with its `[…]` suffix stripped (Anthropic's
docs describe `claude-opus-5`, not `claude-opus-5[1m]`), else `null`. The seed
is checked once, by hand, against
https://platform.claude.com/docs/en/about-claude/models/overview on
2026-09-16, and lives in `server/src/models/catalog.ts`. It is not a second
source of truth in the sense this ADR rejects: `recordContextWindows` always
wins the moment a real turn reports a figure, so the seed can only ever delay
the truth by one turn, never contradict it, and a model the seed does not
recognize resolves to `null` rather than a guess. The web layer never
re-derives this stripped-id fallback itself — `contextWindowFor` in
`web/src/lib/models.ts` returns `null` on anything short of an exact match,
and the panel simply draws no bar when that happens.

We also tried the SDK's own `getContextUsage()` control request as a source.
It reports `maxTokens: 1_000_000` for every model, including Haiku, because
it describes the session's ceiling rather than the specific model's window —
so it cannot tell a 200k model from a 1M one and is not usable here.

**Two rules keep a dynamic list from lying:**

- The `default` row is dropped. It resolves to the same model as a named row,
  and two cards for one model read as a bug. `DEFAULT` becomes Orbital's own
  marker on whichever model Settings names.
- A `[…]` suffix is stripped when matching a model to its **name** (the
  transcript writes `claude-opus-5` even for a session launched as
  `opus[1m]`), but never when looking up its **context window**. Calling a
  200k session "Opus" is harmless; telling it that it has 1M of context is a
  lie the progress bar then draws.

## What follows from it

A model Anthropic ships tomorrow shows up in Orbital without a release. A
model that vanishes stops being offered. Nothing in the repository has to be
edited when either happens — and when the SDK cannot be reached at all,
Orbital serves the last list it saw rather than a guess.
