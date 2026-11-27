---
id: 2026-11-27-recent-model-cards-design
title: New session — cards for the recently used models, the full list behind Other
type: spec
status: active
domain: sessions
related:
  - models-come-from-the-sdk
  - 2026-11-02-work-in-a-worktree-design
  - a-member-is-granted-groups-of-the-allowlist
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
- The last card is **Other**, a card with ▾. It opens the full catalog of
  the account (every row `GET /api/models` returns, catalog order) as a
  list, with **Custom ID…** pinned as its last row. That row turns into a
  mono field in place and ⏎ takes the id; the ID field no longer opens
  under the cards. A model picked there, or the typed id, shows in the
  Other card, selected. A model that already has a card selects that card
  instead. Once a session runs on a model from Other, it is a recent card
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

### Staying put while choosing

- The cards follow the freshest data (the cached list, then the read made
  on open, then the typed directory's preselection) until the first pick
  in this open; after it the row does not change. A change before the
  pick uses the row's fade.
- Launch waits while Custom ID… holds text that is not yet taken (being
  typed, being checked, or refused). A press outside closes the list but
  keeps the typed text for the next open.
- A check still out when the list or the sheet closes, or another model
  is picked, is dropped.
- After a profile or device switch, a pick the new account does not list
  goes back to that account's preselection; it is never launched
  unchecked under the other account.

### How many cards

Width decides, never the number of models (canvas 72c): cards are at
least 96 px, and the row holds `⌊(column + 8) / 104⌋` cards, at least two,
Other included. The 920 px dialog keeps today's four (three recent and
Other), the 1120 px one gets five, a narrow window two. The field is one
56 px row at every width and with any number of models. `DEFAULT` leads
the context line (`DEFAULT · 1M`), so it is never the part that gets cut.

### Out of scope

The detail panel's model switcher (4a), Settings → default model, and
editing or hiding models.

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
gets the same rule (canvas 72d): at 390 px that is two recent cards and
Other, 60 px tall, nothing scrolls sideways. Other opens a bottom sheet in
the 50o shell: the full list in catalog order, 46 px rows, the selected
one with the dot, Custom ID… last as a 52 px row that opens the keyboard
on a mono field. It replaces today's four-family segmented control.
The recent list
comes with `GET /api/models`, which is already on the allowlist. A phone
ahead of its Mac gets no `recentModels` from an older Mac and falls back to
the default-then-catalog order, so no `MAC_FEATURES` gate is needed.

Custom ID… checks the id through `POST /api/models/validate`, which moves
from the `manage` grant to `spawn`: the check is one stripped turn, less
than the session the same grant starts. An older Mac still asks for
`manage`; when the check cannot run at all (grant refused, older Mac,
tunnel down) the phone says why and a second Use takes the id unchecked.
An id the check rejects is never taken.

## Design

Claude Design, `Feature - Model cards.dc.html` in the Orbital canvas
artifact: 72a (the row in the dialog), 72b (every state at the 418 px
column), 72c (widths and the count rule), 72d (phone).
