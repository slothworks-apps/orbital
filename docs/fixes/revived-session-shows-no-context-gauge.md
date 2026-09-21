---
id: revived-session-shows-no-context-gauge
title: A revived session shows no context gauge — its resolved model matches no catalog row
status: done
type: fix
domain: sessions
related:
  - reviving-a-terminal-session-leaves-it-read-only
  - models-come-from-the-sdk
tags:
  - map
  - models
---
# A revived session shows no context gauge — its resolved model matches no catalog row

Reported live: with `map_show_context: true` and an Orbital-owned session
(`056a9b26…`, the revived session from
[[reviving-a-terminal-session-leaves-it-read-only]]), neither the map's
context arc nor the detail panel's context bar renders.

## What actually happens

The numerator is fine. The row reads `source: web`,
`context_used_tokens: 991810` — the runner measured the turn and stored it.
Every gate in `contextFillFor` (`web/src/map/sceneModel.ts:117`–`123`)
passes except the last one: the **denominator** is unknown.

`contextWindowFor` (`web/src/lib/models.ts:106`) resolves the window by
requested `value` first, then by **exact** `resolvedModel` — deliberately
no variant-stripped fallback, per
`docs/decisions/models-come-from-the-sdk.md`. For a revived session both
lookups fail:

1. **`model` is null.** The row was inserted by the indexer as a terminal
   session; the revive flips `source` but never had a requested model
   value to write. So the `value` lookup has nothing to match.
2. **`resolvedModel` is `claude-fable-5`, and no catalog row carries that
   id.** The catalog's Fable row (from the SDK's `supportedModels()`) says
   `resolvedModel: "claude-fable-5-1"`, while the CLI's init message for
   the actually-running session reports `claude-fable-5`. Exact match:
   nothing.

So `contextWindowFor` returns null, `contextFillFor` bails at
`sceneModel.ts:123`, and the detail panel's read-out dies on its own
`contextWindow !== null` gate (`DetailPanel.tsx:642`).

The bitter part: the truth is already known and stored. The learned map in
settings (`model_context_windows`) contains
`"claude-fable-5": 1000000` — measured from a real turn's `modelUsage`,
exactly the source the ADR trusts. It is unreachable because
`shapeModels` (`server/src/models/catalog.ts:147`) only surfaces learned
windows through catalog rows, keyed by the row's own `resolvedModel`, and
no row has this one.

This is not revive-specific in principle: any session whose init-reported
model id differs from every catalog row's `resolvedModel` loses its gauge.
Revive is just the path that produces such sessions today (terminal rows
have no `value`, and the transcript/init spells ids the picker never uses).

## The fix

The learned `model_context_windows` map (exact wire id → tokens) now rides
the `/api/models` payload as `contextWindows`
(`ModelCatalog.learnedContextWindows()`), the store keeps it beside the
catalog, and `contextWindowFor` falls back to an exact lookup of
`session.resolvedModel` in it when no catalog row matches. That stays
inside the ADR: it is an exact-id match against a measured value, not an
invented denominator — the stripped-suffix rule still holds
(`claude-opus-5` never inherits `claude-opus-5[1m]`'s window, covered by
tests). Threaded through `contextFillFor` (map arc), `buildSceneModel` /
`useSceneModel`, and the detail panel's read-out.

(Adding `claude-fable-5` to `SEED_CONTEXT_WINDOWS` was rejected: the seed
only feeds catalog rows, so it would have masked this instance without
fixing the class.)
