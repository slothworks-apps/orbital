---
id: 2026-09-16-agent-model-design
title: Agent model — visible everywhere a session is
status: done
type: spec
domain: sessions
related:
  - 2026-09-15-orbital-design
  - runner-pins-the-session-id
tags:
  - models
  - sessions
---
# Agent model — visible everywhere a session is

**Date:** 2026-09-16
**Visual design:** `Feature - Agent model.dc.html` on the live Claude Design
canvas (project `df77470e-1384-436c-8b25-5e01acfc497f`), artboards `4a`
(detail badge + switcher), `4b` (New session model picker), `4c` (Settings —
default model). Read it through the `DesignSync` MCP; any export under
`design/` is stale.

## Overview

A session's model is invisible in Orbital today. `Runner.start()` already
accepts `options.model` and `POST /api/sessions` already forwards a `model`
field, but nothing ever sets it, nothing stores it, and no surface shows it.
This spec makes the model a first-class, visible property of every session —
terminal-launched ones included — choosable at launch, switchable mid-session,
and defaulted from Settings.

Two things the canvas does not settle, settled here:

1. **The model list is not hard-coded.** It comes from the Agent SDK
   (`Query.supportedModels()`), so a new model appears in Orbital without a
   release.
2. **The context window is not hard-coded either.** `DetailPanel.tsx`'s
   `CONTEXT_BUDGET = 200_000` is wrong by 5× for a 1M-context session. It is
   replaced by a per-model figure learned from `result.modelUsage`.

## What the SDK actually returns

Probed on 2026-09-16 with `@anthropic-ai/claude-agent-sdk` 0.3.272 (bundled
CLI 2.1.272):

| `value` | `resolvedModel` | `displayName` | `description` |
|---|---|---|---|
| `default` | `claude-opus-5[1m]` | Default (recommended) | Opus 5 with 1M context · Best for everyday, complex tasks |
| `opus[1m]` | `claude-opus-5[1m]` | Opus (1M context) | Opus 5 with 1M context · Best for everyday, complex tasks |
| `claude-fable-5-1[1m]` | `claude-fable-5-1` | Fable | Fable 5.1 · Most capable for your hardest and longest-running tasks |
| `sonnet` | `claude-sonnet-5` | Sonnet | Sonnet 5 · Efficient for routine tasks |
| `haiku` | `claude-haiku-4-5-20251001` | Haiku | Haiku 4.5 · Fastest for quick answers |

Three consequences the canvas could not have known:

- There are **five** rows where `4b` draws four cards.
- `default` and `opus[1m]` resolve to the **same** model.
- `ModelInfo` carries **no price and no speed**, so `4b`'s `SLOWEST · $$$$`
  and `FAST · $` lines have nothing behind them. They are replaced by the
  context window, which is a real number.

`displayName` and `description` do give exactly the split the canvas asks for
("version in detail and dialog, family only under the planet label"):
`Opus` is the family, `Opus 5` (the part of `description` before the first
`·`) is the version.

## Decisions

| decision | why |
|---|---|
| Drop the `default` row; `DEFAULT` is Orbital's own marker on the model chosen in Settings | Two cards resolving to one model reads as a bug. Orbital always sends an explicit model, so the CLI's `default` alias is never needed. |
| Lazy SDK probe, last good list persisted | The list must exist *before* the first session is launched, so it cannot be piggybacked on a live session; a boot probe would spawn a CLI on every restart even when nobody opens the dialog. |
| Context window is learned from `modelUsage`, never parsed out of prose | `description` is marketing copy whose format can change silently, and a silent change here produces a wrong number, not a missing one. |
| Two columns: requested model and resolved model | A terminal session only has a resolved model; a freshly launched web session only has a requested one. |
| Subagent model (the `4c` row, moon labels) is out of scope | A moon's model is unknowable from the transcript unless the agent asked for one by name. Deferred to an `idea` document. |

## Data model

Two nullable columns on `sessions`:

| column | holds | written by |
|---|---|---|
| `model` | the **requested** model — an SDK `value` (`opus[1m]`, `sonnet`) | launch, mid-session switch |
| `resolved_model` | the model that **actually ran** (`claude-opus-5`) | indexer (transcript), runner (`system/init`) |

### Resolving a session to a catalog row

In order:

1. `session.model` equals a row's `value` → that row.
2. `session.resolved_model` equals a row's `resolvedModel` → that row.
3. `session.resolved_model` equals a row's `resolvedModel` **with any
   `[…]` suffix stripped from both sides** → that row.
4. No match → show `resolved_model` verbatim, or nothing when it is null too.

Step 3 exists because the transcript records `claude-opus-5` even for a
session launched as `opus[1m]`. It applies to **naming only**. The context
window is looked up by exact `resolvedModel` and never by the stripped form:
labelling a 200k session "Opus" is harmless, telling it that it has 1M of
context is a lie the progress bar would then draw.

### Migration

One Drizzle migration adds both columns and sets `indexed_mtime = 0` on every
row, so the indexer re-reads each transcript once and backfills
`resolved_model`. The same one-shot re-read the title cleanup already uses
(`indexer.ts`). Cost: one full re-parse of `~/.claude/projects` on the first
boot after upgrade.

## Server

### `server/src/models/catalog.ts` (new)

`ModelCatalog`, constructed with an injected `queryFn` exactly as `Runner` is,
so tests never spawn a CLI.

- **Probe.** `query({ prompt: <stream that never yields>, options: { cwd } })`
  → `await q.supportedModels()` → close. No user message is ever enqueued, so
  the probe costs a process (~1 s) and zero tokens.
- **Freshness.** `list()` returns the persisted list immediately and refreshes
  in the background (stale-while-revalidate). Only a cold first run — nothing
  persisted yet — awaits the probe. A failed probe is logged and leaves the
  stored list standing; `list()` never rejects and never invents a model.
- **Shaping.** Drop `value === 'default'`, then dedupe by `resolvedModel`
  keeping the first occurrence. Derive `family` (`displayName` up to its first
  `(`), `version` (`description` up to the first `·`) and `blurb` (the rest).
- **Context windows.** `recordContextWindows(modelUsage)` merges
  `modelUsage[model].contextWindow` into a stored map, keyed by the model
  string the SDK used. `Runner` calls it on every `turn_result`.

Persistence uses two `settings` keys — `models_catalog` (JSON array) and
`model_context_windows` (JSON object) — rather than new tables. Both are
caches of something the SDK owns; losing them costs one probe.

### Wire shape

```ts
interface OrbitalModel {
  value: string            // 'opus[1m]'  — what gets sent to the SDK
  resolvedModel: string    // 'claude-opus-5[1m]'
  family: string           // 'Opus'      — the map label
  version: string          // 'Opus 5 with 1M context' — full SDK wording, not shown directly
  shortVersion: string     // 'Opus 5'    — detail chip, switcher rows, dialog cards, transcript divider
  variant: string | null   // '1M'        — appended to shortVersion, but only on an EXACT match (see below)
  blurb: string            // 'Best for everyday, complex tasks'
  contextWindow: number | null
}
```

`shortVersion` and `variant` were added during the run — `version` alone (the
full "Opus 5 with 1M context" the SDK's `description` gives) turned out to
wrap every surface that has to show it in one line, and the variant needed
somewhere to live that was not the map label. Naming, corrected:

- Detail chip and switcher rows: `shortVersion`, with ` (variant)` appended —
  but only when the session's model matched its catalog row **exactly**
  (`session.model` equalling the row's `value`, or an exact `resolvedModel`).
  The variant-stripped fallback match (below) exists so a terminal session
  has a name at all; it does not know which variant actually ran, so it must
  not print one the context bar cannot back up.
- New session dialog cards and the "last used here" note: `shortVersion`.
- The map label: `family` — never the version, never the variant.
- The transcript divider: `shortVersion`, upper-cased (`OPUS 5 → SONNET 5`).

`ApiSession` gains `model: string | null` and `resolvedModel: string | null`.
No `contextWindow` on the session — the client derives it from the catalog, so
it corrects itself as the registry learns.

### Endpoints

- `GET /api/models` → `{ models: OrbitalModel[] }`.
- `POST /api/sessions/:id/model` `{ model }`:
  - live in `Runner` → `Runner.setModel(id, model)` (which calls the
    generator's `setModel`) and update the row;
  - `ended` → update the row only; it applies when the session is revived;
  - live in a terminal (`registry.get(id)`) → `409`, same as the existing
    "session is live in a terminal" rule. Orbital does not own that process.
  - Either way, publish a `sessions` upsert so every surface re-renders.
- `POST /api/sessions` stores `body.model` on the row (it already forwards it
  to `Runner`).
- `GET /api/projects` returns `{ projects: Array<{ cwd, lastModel }> }` — the
  query already groups by `cwd` ordered by `max(last_at)`, so the most recent
  session's model comes along for free. This is what `4b`'s "last used here"
  reads.

### Fixed in passing

The revive path in `POST /api/sessions/:id/messages` restarts a session
without its model, silently moving a revived session onto the CLI default. It
will pass `row.model`, the same way it already passes `row.permission_mode`.

### Clear

`POST /api/sessions/:id/clear` with `startNew` uses the **Settings default**,
not the cleared session's model — `4c` says the default model is "used by
Clear". Deliberately unlike `inherit_permission_mode`: no
`inherit_model` setting is added.

### Transcript and live stream

- `extractMeta` also returns the last non-sidechain assistant entry's
  `message.model` → `resolved_model`.
- `ChatMessage` gains `model?: string`; `entriesToMessages` and
  `sdkToChatMessages` both fill it from `message.model`.
- `Runner.pump` reads `system`/`init` messages for `msg.model`, persists it as
  `resolved_model` and publishes it, so a web session shows its model before
  its first answer.

## Web

### `ui/ModelCards.tsx` (new)

Built once and used twice, exactly as `ui/ModeCards.tsx` is: the full variant
for `4b` (card with shortVersion, blurb and a context line), a `compact`
variant for `4c`. The grid is `auto-fit` rather than a fixed four columns —
the list is dynamic and a fifth model must wrap, not overflow.

### 4a — detail badge and switcher

A mono chip in the `Badge` family showing `shortVersion`, with ` (variant)`
appended when the session's model matches its catalog row exactly (see the
naming table above) — accent-outlined with a `▾`, sitting left of the
permission-mode badge. It opens a listbox popover headed `MODEL · APPLIES
FROM NEXT TURN`, marking the current row `CURRENT` and the Settings default
`DEFAULT`, footed with "Context is kept. A divider marks the switch in the
transcript." Escape closes it through `useEscapeLayer`, like every other
layer in this app. Dismisses on an outside pointerdown too, the same
mechanism `ui/Select.tsx` uses, and resets closed whenever the selected
session changes. On a terminal-live session, or when the catalog is empty,
the chip is inert and titled with the reason.

### The transcript divider

Derived, not emitted: `Transcript` draws
`SONNET 5 → OPUS 5 · 14:02` (each side `shortVersion`, upper-cased) wherever
an assistant message's `model` differs from the previous assistant message's.
It therefore survives a reload, needs no storage, and also shows switches
made in a terminal that Orbital never performed.

### The context bar

`CONTEXT_BUDGET` is deleted. The denominator is the session's model's
`contextWindow` from the catalog; with no match the bar keeps the 200k
fallback and the read-out still says `— / 200k ctx` rather than a number
nobody measured.

### 4b — New session dialog

A `MODEL` group between `PROJECT DIRECTORY` and `PERMISSION MODE`, with
`last used here: <shortVersion>` on the right of the group label when the
typed cwd is among the known projects — matched by SDK value OR resolved id
(a terminal-launched project's newest session only ever has the latter), and
shown only when something actually matches; a raw id never renders.
Preselection: the project's last model when `remember_model_per_project` is
on and known, otherwise `default_model`. The footer summary line gains the
model.

### 4c — Settings

In `NEW SESSIONS`: a "Default model" row (compact cards) and a "Remember last
model per project" checkbox. In `MAP`: a "Model name under planet label"
toggle. New keys and their defaults:

| key | default | note |
|---|---|---|
| `default_model` | `sonnet` | per the canvas; falls back to the catalog's first row when the SDK does not offer it |
| `remember_model_per_project` | `true` | |
| `map_show_model` | `true` | |

The `Subagent model` row from `4c` is **not** built — see Out of scope.

### Map

`sceneModel` carries each planet's model family; `Planet` renders it as a
second line under the title, mono and quiet, gated by `map_show_model`.
Family only, never the version. Its colour is `rgba(160,190,225,.7)` (canvas
4a) while the session is live, but dims to whatever the title itself dims to
once the session has ended — a fixed value would otherwise leave the family
line brighter than the name it sits under.

## Error states

| situation | behaviour |
|---|---|
| Probe fails, a list is stored | Serve the stored list; log once. |
| Probe fails, nothing stored | `GET /api/models` returns an empty array; the pickers render an explanatory empty state and launch still works (no `model` is sent, so the CLI's own default applies). |
| Switch on a terminal-live session | `409`, surfaced as a toast; the badge was already inert. |
| Session's model matches no catalog row | Show `resolved_model` verbatim; context bar falls back to 200k. |
| `modelUsage` reports a model the catalog does not list | Stored anyway — the map is keyed by model string, not by catalog membership. |

## Testing

Server: catalog shaping (drop `default`, dedupe, derive family/version/blurb),
probe failure leaving the stored list intact, context-window learning and its
exact-match-only lookup, `GET /api/models`, `POST /:id/model` in all three
session states, `Runner.setModel`, the revive path carrying the model,
`extractMeta` reading the model, the indexer writing `resolved_model`.

Web: `ModelCards` in both variants, the detail switcher (open, select, inert
when terminal-live), the divider appearing exactly at a model change, the
context denominator following the catalog, the dialog's preselection rules,
the three settings controls, and the planet's second label line.

## Out of scope

- **Subagent model** — the `4c` row and the per-moon model label from `4a`.
  `options.env` can carry `CLAUDE_CODE_SUBAGENT_MODEL`, so the setting is
  buildable; the moon label mostly is not, because `Task` tool_use input only
  carries `model` when the agent asked for one by name. Recorded as an `idea`.
- **Effort levels.** `ModelInfo` exposes `supportsEffort` and
  `supportedEffortLevels` and the canvas says nothing about them. A separate
  feature, not a rider on this one.
- **Cost.** No price data exists in `ModelInfo`; `4b`'s `$$$$` line is
  replaced by the context window rather than reconstructed from a table
  Orbital would have to maintain by hand.
