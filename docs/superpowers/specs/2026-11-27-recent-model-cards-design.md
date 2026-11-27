---
id: 2026-11-27-recent-model-cards-design
title: New session — cards for the recently used models, the full list behind Other
type: spec
status: draft
domain: sessions
related:
  - models-come-from-the-sdk
  - 2026-11-02-work-in-a-worktree-design
tags:
  - new-session
  - models
---
# Cards for the recently used models

The New session dialog shows its models as cards while the catalog is
short and as one dropdown once it outgrows `MODEL_TILES_MAX` (canvas 63a).
A CLI that offers older generations next to the current one (Opus 5,
Opus 4.8, Sonnet 4.6, Fable 5.1 …) pushes every account over that limit,
so the dropdown is what people see. The model is then one click further
away, and the choice made most often — the same model as last time, or the
one other model used alongside it — has no faster path than a model used
once a year.

## What changes

- The dialog always shows cards. The cards are the models this account
  used most recently, newest first, one card per model.
- The last card is **Other**. It opens the full catalog of the account
  (every row `GET /api/models` returns) as a dropdown, with the custom ID
  field (canvas 63a) as its last entry. A model picked there is selected
  for this launch; once a session runs on it, it is one of the recent cards
  next time.
- Preselection does not change: this project's last model when
  `remember_model_per_project` allows it, then the Settings default, then
  the first row. The preselected model always has a card, taking the
  oldest card's place when it is not among the recent ones.

### Which models are recent

- Per Claude directory (account): Work's history does not decide Personal's
  cards, because the two accounts offer different models.
- Counted from sessions started from Orbital and from the terminal alike,
  newest `lastAt` first, deduplicated on the requested `value` (`opus[1m]`),
  falling back to the resolved id for terminal sessions.
- A recent model the catalog no longer lists (an id the account lost, a
  retired generation) is not shown as a card; it is still reachable through
  Other → custom ID.
- No history yet (a new install, a new account): the Settings default and
  then the catalog's own order fill the cards, which is what the dialog
  shows today for a short catalog.

### How many cards

Open: as many as fit one row of the dialog's Model field next to Other
(four today). To be settled in Claude Design together with the layout.

## Server

`GET /api/projects` already returns each project's last model. The cards
need the newest distinct models per Claude directory, which nothing
returns yet: a `recentModels` list on `GET /api/models?claudeDir=` (newest
first, ids as stored, capped at a small constant). Answering it from the
models route keeps it next to the catalog it is filtered against, and a
remote machine answers it for its own directories through the same route.

## Scope

- **Who:** everyone who starts sessions from the dialog; most of all
  people whose account lists more models than the cards can hold, which
  today is every account on a current CLI.
- **Where:** on by default, replacing the tiles/dropdown switch. The
  switch was itself a fallback for long catalogs; this keeps its purpose
  (a long list does not crowd the dialog) without hiding the common choice.
- **What an existing user notices:** the dropdown they see now becomes
  cards again; the models they used are one click away, the rest are under
  Other.
- **What can be set:** nothing new. `remember_model_per_project` and the
  default model keep their meaning.

## Phone

The phone's New session screen (`web/src/mobile/screens/NewSessionScreen.tsx`)
lists the catalog the same way and gets the same cards: the recent list
comes with `GET /api/models`, which is already on the allowlist. A phone
ahead of its Mac gets no `recentModels` from an older Mac and falls back to
the default-then-catalog order, so no `MAC_FEATURES` gate is needed.

## Design

The look and placement come from Claude Design: the cards row, the Other
card and its dropdown, and the empty-history state. Prompt handed to Claude
Design on 2026-11-27; this spec links the artboard once it exists.
