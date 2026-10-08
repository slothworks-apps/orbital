---
id: 2026-09-21-settings-sections-design
title: The settings dialog, redivided — General and Notifications join the nav
status: done
type: spec
domain: web
related:
  - settings-sections-split-by-kind
  - desktop-startup-window-and-updates
  - the-hole-subsumes-map-declutter
  - context-fill-arc
  - 2026-09-16-electron-wrapper-design
tags:
  - settings
  - notifications
  - desktop
---
# The settings dialog, redivided

`web/src/panels/Settings.tsx` renders six nav items, of which three are
live. *Sessions* holds thirteen rows spanning three unrelated subjects and
duplicates *Appearance*'s `MAP` kicker; *General*, *Permissions* and
*Shortcuts* are disabled placeholders. This spec sets out the target
layout for all seven sections under the rule agreed in
[[settings-sections-split-by-kind]], and marks which parts are built now.

## 1. The nav

```
General · Sessions · Notifications · Permissions · Tags & rules · Appearance · Shortcuts
```

*Notifications* is a new item inserted after *Sessions*. Every other item
keeps the order and label it has in canvas 1h. *Permissions* and
*Shortcuts* stay `disabled` — Shortcuts has a canvas
(`Feature - Shortcuts.dc.html`) but no spec, and Permissions is waiting on
the ability to open files outside a session's folder.

The version footer at the bottom of the nav (`orbital`, `claude-code`)
stays where it is. No `About` row.

**A visit resumes where the last one left off.** The dialog used to open on
Sessions unconditionally, which was right when Sessions was the only live
section and is a guess now that there are five. The chosen section is stored
as `settings_last_section` — the same settings-table mechanism that already
persists `sidebar_collapsed` and `sidebar_width` — and a nav click writes it
fire-and-forget: navigating is not a preference change, so it must not raise
the header's "saved · just now", and a failed write costs the next visit its
starting section and nothing more.

`initialSection()` falls back to the nav's first row for anything
unrecognised. That covers a key from a future build and a hand-edited
database, but the case that will actually happen is a section that was live
when it was stored and has since been disabled — the fallback is what keeps
that from stranding someone on an inert page.

## 2. Sessions, after

```
NEW SESSIONS        Default model  (+ Remember last model per project)
                    Default permission mode
                    Default project directory
CLEAR & LIFECYCLE   Confirm before Clear
                    Generate session titles from content
                    New session inherits  [Tags] [Permission mode]
                    Mark session ended after
                    Release ended sessions into history after
```

Leaving: the whole `MAP` kicker and its three rows (to Appearance),
`Claude Code executable` (to General), `Lineage depth on the map` (to
Appearance). The second kicker is renamed from `CLEAR & LINEAGE`.

`Release ended sessions into history after` stays, with its copy
unchanged — it decides a session's fate, not its drawing.

## 3. Appearance, after

```
MAP             Default planet size  + collapsible preview
                Scale labels with bodies
                Model name under planet label            (from Sessions)
                Lineage depth on the map                 (from Sessions)
CONTEXT USAGE   Context usage on planets                 (from Sessions)
                Context thresholds  74% / 89%            (from Sessions)
                Show "/compact" badge above the second   (from Sessions)
```

`CONTEXT USAGE` is a new kicker rather than four more rows under `MAP`.
The thresholds also colour sidebar rows, so filing them under a heading
that says "map" would misdescribe them.

Row copy, the lineage chain illustration, the threshold colour dashes and
the model sample chip all move verbatim, and so do their settings keys —
`map_show_model`, `map_show_context`, `context_threshold_warn`,
`context_threshold_critical`, `map_show_compact_badge`, `lineage_depth`.
Nothing changes server-side and no migration is needed; only the column
that renders each `Row` changes.

One deliberate exception to "verbatim": the sample chip beside the model
toggle is prefixed `e.g.`. Canvas 4c has the bare upper-cased family, which
reads as a status badge rather than as a preview of the string the map will
draw. The prefix carries no tracking and a dimmer ink so the sample still
leads.

## 4. General, new

```
RUNTIME            Claude Code executable          (from Sessions)
                   Claude directory
                   Billing                          read-only
DATA               Database                         read-only
                   Delete sessions older than
STARTUP & WINDOW   deferred — see below
```

**Claude Code executable** moves with its copy intact, including the
sentence that a change needs a restart.

**Claude directory** exposes what `ORBITAL_CLAUDE_DIR` already overrides in
`server/src/config.ts`: the `~/.claude` tree the watcher reads. Empty means
`~/.claude`. Like the executable, the server reads it at boot, so the row
carries the same restart sentence. The env var keeps precedence over the
stored value — an operator who set it meant it.
`2026-10-04-multiple-claude-directories-design` replaces this row with a
list of directories.

**Billing** is a read-only status line, not a control: `Subscription` or
`API key (ORBITAL_USE_API_KEY)`. The server decides this at startup by
whether it deleted `ANTHROPIC_API_KEY` from its environment, and the
decision is worth stating where the user can find it. Making it editable
would put "start charging my card" behind a toggle.

**Database** shows `<dataDir>/index.db` read-only, with `Copy path`
(`Reveal in Finder` is out of scope — see § 9).

**Delete sessions older than** — `Never` (default) / `30 days` / `90 days`
/ `1 year`. This is the only destructive row in the dialog: it removes rows
from the index, not from `~/.claude`, and that distinction has to be in the
description. Changing it away from `Never` asks for confirmation naming the
number of sessions it will drop.

Deleting the rows is not enough on its own: `indexProjects` inserts every
`.jsonl` the database lacks, so a swept session whose transcript is still on
disk would be back within one scan. Every sweep therefore writes a
tombstone, and the indexer obeys it until the transcript is written to
again — [[swept-sessions-need-a-tombstone]] has the full reasoning and what
was rejected.

The sweep runs at boot, before the indexing, and again on the `PATCH` that
sets the policy — so the confirmation's "this deletes N sessions" is about
now, not about some later restart.

Two things make the off switch trustworthy, and both are deliberate.
`'never'` is the absence of a cutoff rather than a very large one, and every
unreadable value — empty, `'0'`, `'-30'`, `'30.5'`, garbage — disarms it
too: for a setting that deletes, "I could not parse this" must never resolve
to a default. And three kinds of session are exempt whatever the cutoff says
— pinned ones (a pin is the user saying keep this, and a clock must not
overrule it), ones the Runner still owns, and ones with no `lastAt` to
compare.

The confirmation itself asks only when there is something to warn about:
turning the policy off, or picking one that would take nothing, saves
straight away. If the count cannot be fetched it still asks, saying so —
failing open on a destructive setting would be the wrong way round, and
failing closed would make the row unusable whenever the server is busy.

**STARTUP & WINDOW** — launch at login, close-to-menu-bar, restore the
last view — and a `Check for updates automatically` row are the target
shape, but none of that behaviour exists in `desktop/`: there is no tray,
no updater and no login item. They are specified in
[[desktop-startup-window-and-updates]] and this section renders without the
group until that work lands.

**What General holds today.** `RUNTIME` and `DATA` in full; only
`STARTUP & WINDOW` is missing, waiting on behaviour `desktop/` does not
have. The two read-only rows draw only once `GET /api/health` has answered:
a placeholder path or billing mode shown while the fetch is in flight, or
after it failed, could be read as real, and these rows state where your data
lives and who is being charged. The `DATA` kicker itself is unconditional,
because the retention row under it needs no server facts.

Under the browser (no Electron), `RUNTIME` and `DATA` render as above;
nothing is desktop-only among them.

## 5. Notifications, new

```
WHEN   A session needs your input
       A session ends
       A session fails
HOW    Only when Orbital is in the background
       Play a sound
```

The three `WHEN` rows are the three notifications
`desktop/src/lib/notifications.ts` already produces, and they map exactly:

| row | today |
|---|---|
| needs your input | `bodyFor` on `working → needs_input` |
| ends | `bodyFor` on `working → ended` |
| fails | `onErrorEvent`, `error.kind === 'session_failed'` |

All three are on by default, which is today's behaviour. The fold stays
pure — `SessionNotifier` may not import electron — so the settings arrive
as a plain object passed in. A disabled event still folds; it just returns
`null` instead of a notification, so turning one back on reports the *next*
transition rather than replaying a backlog.

`Only when Orbital is in the background` is **on** by default, because that
is what `main.ts` does today and does unconditionally:
`if (!target || target.isFocused()) return;`. The row makes an existing
hard-coded rule optional rather than adding a new one — off means notify
even with the map in front of you. It is the one row that needs electron,
so the check stays where it is, after the fold returns, and is skipped only
when the setting is off.

`Play a sound` sets `silent: true` on the `Notification` when off. Default
on, matching today, where `silent` is never set and macOS plays its own.

### How main.ts learns the settings

There is no `settings` topic on the WebSocket — the server publishes
`sessions` and `errors` only — so the notifier's settings do not arrive on
the feed that drives it. Rather than grow a topic for five booleans,
`main.ts` reads `GET /api/settings` at startup and on every socket
reconnect (it already resets the notifier there), and the renderer sends an
IPC `settings-changed` after a `PATCH /api/settings` succeeds. The renderer
is the only thing that changes them, so that message is both exact and
nearly free. A missed one costs a single notification shown under the
previous rule, and the next reconnect corrects it.

In the browser the section renders with a line saying notifications are a
desktop feature; the toggles still write, so a later web implementation or
simply opening the desktop app honours them.

## 6. Keys

New settings rows, all stored the same way as the existing ones — string
values through `PATCH /api/settings`:

```
settings_last_section             'general'  (fallback, never seeded)
claude_directory                  ''         (empty = ~/.claude)
delete_sessions_older_than_days   'never'
notify_needs_input                'true'
notify_session_ended              'true'
notify_session_failed             'true'
notify_only_when_background       'true'
notify_sound                      'true'
```

Every default above reproduces today's behaviour exactly, so a database
that has never seen this dialog behaves as it does now.

The keys the Appearance move carries over keep their existing names and
values — `context_threshold_warn`, `context_threshold_critical`,
`map_show_compact_badge`, `map_show_model`, `map_show_context`,
`lineage_depth`.

`Billing` and `Database` read from a new field on the existing health
payload (`HealthInfo`, which `desktop/src/main.ts` already probes at
startup); they are not settings and get no rows.

## 7. What the server has to change

Most of this spec is a question of which column renders which `Row`, so
it is worth being explicit about the four places `server/` is touched —
and about the three that look like server work and are not.

**Nothing at all.** The §2/§3 moves carry their keys and values with them,
so no migration and no route changes. And the five `notify_*` keys need no
route work either: `PATCH /api/settings` has no allowlist — it iterates
`Object.entries(req.body)` and stores whatever arrives — so they only need
their defaults added to `DEFAULT_SETTINGS` in `server/src/db/database.ts`.
That is a data edit to one object.

**`GET /api/health` grows two fields**, for `Billing` and `Database`. Small,
but the comment above that endpoint states its field names are a contract
with the desktop app, so this lands in `server/src/index.ts` and
`desktop/src/` together.

**`claude_directory` needs a boot reorder.** `buildServer` resolves
`claudeDir` at `index.ts:137`, six lines before `openDb`, so the settings
table does not exist yet when the path is decided. Opening the database
first fixes it, and is safe because `dbPath` hangs off `dataDir`, which is
independent of `claudeDir` — there is no cycle to untangle. The precedent
is already in the file: `claude_executable_path` is read from the settings
store at `index.ts:178`, after the database is up. Precedence is
`ORBITAL_CLAUDE_DIR` over the stored value over `~/.claude`; an operator who
set the env var meant it.

**`delete_sessions_older_than_days` is the only genuinely new logic** in
the whole spec, and the only part that needed a migration.
`server/src/retention.ts` holds the policy — parse, cutoff, exemption
predicate, count and sweep — `swept_sessions` and migration `0010` hold the
tombstones ([[swept-sessions-need-a-tombstone]]), and `indexProjects` gained
the check that obeys them. `GET /api/sessions/retention-preview` is the one
new route, and it runs the sweep's own predicate rather than a second copy:
a count that disagreed with the delete would be worse than no count.

One more ordering constraint came with it: `buildServer` sweeps BEFORE it
indexes. Both orders end in the same state, but the other way round parses
every transcript on the machine to build rows it is about to delete.

## 8. Testing

Worth a test:

- the sweep behind `delete_sessions_older_than_days` — the cutoff and its
  boundary, the `never` sentinel and every unreadable value, and each of
  the three exemptions
- the tombstone round trip, which is the part that can silently stop
  working: a swept session must survive a re-index, and must come back the
  moment its transcript is written to again. Both mtimes are set explicitly
  in that test — two `Date.now()` calls landing in the same millisecond
  would make it flaky about the one thing it exists to pin down
- the confirmation's branches: it asks with a count, it saves nothing when
  declined, it skips the prompt for `never` and for a zero count, and it
  still asks when the count cannot be fetched
- `SessionNotifier` with each event disabled, asserting the fold still
  tracks state so a re-enable reports the *next* transition rather than a
  stale one
- `claude_directory` precedence: env var over stored value over default
- `initialSection()`: stored, absent, unknown and disabled-since-stored
- `parseNotificationSettings()`: an absent key reads on, only the literal
  `'false'` reads off, a non-object payload yields the defaults

Not worth a test: which column renders which `Row`. The moves in §2 and §3
change no behaviour, and a test asserting a row's section would fail the
next time someone reorders the dialog on purpose. The web tests do have to
*navigate* to a section before touching its rows, but that is setup — no
assertion there should claim where a row lives.

One trap the existing suite walked into and the rewrite had to fix: three
tests asserted a control was **absent**, which stayed true once the row
moved to a section they never opened. They passed for the wrong reason.
Every negative assertion about a row now anchors on something positive in
the same section first.

## 9. Out of scope

- *Permissions* and *Shortcuts* content.
- Per-tag or per-project notification scoping, and quiet hours. The
  section exists so they have somewhere to go.
- Anything in [[desktop-startup-window-and-updates]], which is also why
  General still has no `STARTUP & WINDOW` group.
- `Reveal in Finder` on the Database row. It needs an IPC hop and
  `shell.showItemInFolder`; `Copy path` works in both the browser and the
  desktop app, so the reveal is a nicety rather than the feature.
