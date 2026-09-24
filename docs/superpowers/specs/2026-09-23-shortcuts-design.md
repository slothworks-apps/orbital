---
id: 2026-09-23-shortcuts-design
title: Shortcuts — one keymap, ⌘ as Orbital's modifier, a Settings pane read from it
status: done
type: spec
domain: web
related:
  - cmd-is-orbitals-modifier-and-digits-bind-by-position
  - new-session-shortcut-moves-to-option-n
  - 2026-09-21-settings-sections-design
  - 2026-09-23-detached-session-windows-design
  - 2026-09-24-page-headers-design
  - how-hard-it-is-to-say-yes-is-the-readers-choice
  - desktop-wrapper-electron
tags:
  - shortcuts
  - settings
  - desktop
---
# Shortcuts

Orbital listens for a handful of keys today, each wired where it happened to
be needed: ⌥N and ⌥F in `SpaceMap`, ⌘K in `Sidebar`, ⌘[ in `PageBar`, ⌘1 in
the Electron menu, and a scatter of ⏎ / Esc / digits inside dialogs and cards.
Nothing lists them, two of them advertise a key that does not work, and the
one place that mentions ⌘⇧N (Settings → Sessions) binds nothing.

This spec gives Orbital one **keymap**: every binding declared once, matched
by one function, dispatched by one listener, mirrored into the Electron menu,
and listed in *Settings → Shortcuts*. It also fixes the set of default
bindings, chosen for the app's real target (the desktop app on macOS) and for
a Czech QWERTZ keyboard, on which the earlier ⌥-letter and `[` bindings were
wrong or unreachable.

The canvas `Feature - Shortcuts.dc.html` is the visual reference for the
pane. Its list of bindings is a mock and is **not** the source of the
bindings below.

## 1. Rules

1. **⌘ is Orbital's modifier.** App-level and session-level actions are
   ⌘ + letter, like a native macOS app. ⌘⇧ + letter is the "stronger" form
   of the same idea (⌘N new, ⌘⇧N clear and start over). ⌥ is kept for one
   meaning only: *open this somewhere else* (⌥⏎ and ⌥-click open in the
   IDE). Bare keys (⏎, Esc, arrows, digits, Tab) act only inside a context
   where nobody is typing.
2. **Letters bind by character, digits by position.** Cmd on macOS does not
   change the character a key produces, so ⌘ + letter is matched on
   `e.key` (lower-cased) and lands on the key that prints that letter on
   any layout — Y and Z included on QWERTZ. On a Czech layout the digit
   row prints `+ ě š č ř ž ý á í é` without Shift, so digits are matched on
   `e.code` (`Digit1`…`Digit9`): ⌘1 is the key labelled "+ 1", no Shift.
3. **Punctuation is limited to `,` and `.`**, which sit on the same keys on
   a Czech layout. No default binding uses `/ [ ] - = ;` or `'`.
4. **A ⌘ chord that does not edit text stays live while typing.** ⌘N, ⌘K,
   ⌘B, ⌘T, ⌘P, ⌘J, ⌘F, ⌘, and the digit chords fire from inside a text
   field. Chords that mean something in a text field — ⌘⌫ (delete to line
   start), ⌘. and ⌘↑ (caret to top) — and every bare key are guarded by
   the typing check and fall through to the field.
5. **One binding per action.** The pane may print a muted alternative
   (design: "a second binding for the same action sits on the same row,
   muted") but no default action has one.
6. **No cs/en switch.** Rules 2 and 3 make the bindings layout-independent
   without one. Should an ⌥-letter chord ever return, it would need
   `navigator.keyboard.getLayoutMap()` to map its letter to a physical
   key; that is deliberately not built.

## 2. The bindings

| Scope | Action | Keys | Notes |
|---|---|---|---|
| Global | New session | ⌘N | replaces ⌥N; opens the new-session dialog |
| Global | Search sessions | ⌘K | unchanged; focuses the sidebar search |
| Global | Toggle sidebar | ⌘B | collapse / expand the rail |
| Global | Settings | ⌘, | opens the Settings dialog |
| Global | Error log | ⌘⇧E | opens the error log |
| Global | Map | ⌘1 | shows the main window and, if it is on another page, loads the map |
| Global | Stats | ⌘2 | loads `/stats` in the main window |
| Global | Up one level | ⌘↑ | replaces ⌘[; the parent crumb of the page bar; typing-guarded |
| Global | Next / previous session | ⌃⇥ / ⌃⇧⇥ | sidebar order (PINNED then ACTIVE), wraps |
| Global | Next session needing input | ⌘J | sessions in `needs_input`, sidebar order, after the current one, wraps; no-op when none |
| Map | Fit the map | ⌘F | replaces ⌥F |
| Map | Deselect | Esc | unchanged (escape layer) |
| Session | Interrupt the run | ⌘. | opens the Stop dialog, as the button does; typing-guarded |
| Session | Clear and start over | ⌘⇧N | same path as the Clear button (respects "Confirm before Clear") |
| Session | End session | ⌘⌫ | opens the End dialog; typing-guarded |
| Session | Pin / unpin | ⌘P | toggles the pin |
| Session | Change tag | ⌘T | opens the tag select in the detail header; arrows / type-ahead pick |
| Session | Switch model | ⌘⇧M | opens the model switcher; no-op where it is not rendered |
| Session | Open in new window | ⌘⇧D | desktop only, not in a detached window |
| Composer | Send / newline | ⏎ / ⇧⏎ | unchanged |
| Composer | Start session | ⌘⏎ | unchanged (new-session dialog) |
| Dialogs & cards | Confirm | ⏎ | unchanged (End, Stop, Clear) |
| Dialogs & cards | Close / step back | Esc | unchanged (escape layer) |
| Dialogs & cards | Pick an answer | 1–9 | question card; **now by position** (`e.code`), was by character |
| Dialogs & cards | Move / send | ↑ ↓ / ⏎ | unchanged |
| Files | Open in IDE | ⌥⏎ | unchanged (file viewer) |
| Files | Open path in IDE | ⌥-click | unchanged; printed with a dashed "pointer gesture" cap |

Deliberately unbound: approve / deny a permission
([[how-hard-it-is-to-say-yes-is-the-readers-choice]]), map zoom in / out
(`+ −` do not sit where a US layout has them and the wheel does it), the
walkthrough, rename.

Retired: ⌥N, ⌥F, ⌘[. The idea [[new-session-shortcut-moves-to-option-n]]
is superseded by this spec.

## 3. The keymap — `web/src/lib/keymap.ts`

A pure module, no React, no DOM beyond `KeyboardEvent`'s shape.

```ts
export type Scope = 'global' | 'map' | 'session' | 'composer' | 'dialogs' | 'files'

/** 'meta+shift+n', 'ctrl+shift+Tab', 'meta+Digit2', 'meta+,', 'Enter', 'alt+Enter' */
export type Chord = string

export interface Command {
  id: string            // 'session.interrupt'
  label: string         // 'Interrupt the run'
  scope: Scope
  chords: Chord[]       // [0] primary; the rest print muted
  note?: string         // the pane's small line under the label
  whileTyping: boolean  // rule 4
  /** Where it appears in the Electron menu, if anywhere. */
  menu?: { menu: 'File' | 'Session' | 'View' | 'Window'; order: number }
  /**
   * Display-only rows: the key is handled by a component with the shared
   * `matches` helper (composer ⏎, dialog ⏎, question digits) or by the
   * escape layer. The dispatcher never fires these.
   */
  local?: true
  /** A pointer gesture drawn as a dashed cap, e.g. '⌥-click'. */
  gesture?: string
  /** The caps to print instead of the chords — `['1–9']`, `['↑ ↓']`. */
  display?: string[]
}

export const COMMANDS: readonly Command[]
export const SCOPES: readonly { scope: Scope; title: string; when: string }[]
// GLOBAL 'anywhere in the app' · MAP 'nothing selected, focus on the canvas' ·
// SESSION 'a session is selected' · COMPOSER 'caret in the input' ·
// DIALOGS & CARDS 'a dialog or a question is up' · FILES 'a file is open'

export function parseChord(chord: Chord): { mods: Set<Modifier>; key: string }
export function matches(chord: Chord, e: KeyboardEventLike): boolean
export function command(id: string): Command
export function isTypingTarget(target: EventTarget | null): boolean
export function digitFromEvent(e: KeyboardEventLike): number | null   // Digit1..9 or Numpad1..9 → 1..9, else null
export function chordGlyphs(chord: Chord): string[]      // 'meta+shift+n' → ['⌘','⇧','N']
export function chordLabel(chord: Chord): string         // '⌘⇧N' — for keycap hints in the UI
export function accelerator(chord: Chord): string        // 'CmdOrCtrl+Shift+N' — Electron
export function keymapGroups(query?: string): Group[]    // the pane's data, filtered
```

`matches` implements rules 2 and 3: the modifier set must be exactly the
chord's (`meta` matches `metaKey` on macOS and `ctrlKey` elsewhere; `ctrl`
matches `ctrlKey` alone and, because `ctrlKey` already stands in for `meta`
off macOS, a `ctrl` chord (⌃⇥) can only ever match on macOS — the only
platform Orbital ships for); a key part that is `DigitN` compares `e.code`;
a single character compares `e.key.toLowerCase()`; anything else (`Enter`,
`Tab`, `Escape`, `Backspace`, `ArrowUp`…) compares `e.key`. `⇧` + letter
arrives as the upper-case letter and is normalised by the lower-casing.

On macOS `meta` matches `metaKey` only; `ctrlKey` stands in for it on other
platforms, because Ctrl + letter is an editing key inside a macOS text
field.

`isTypingTarget` is the helper duplicated today in `SpaceMap` and `Sidebar`;
both import it from here.

Glyphs: ⌘ ⇧ ⌥ ⌃ ⏎ ⌫ ⇥ ␣ ↑ ↓ ← → and `esc` (lower-case word, per the
canvas). Letters print upper-case; `,` and `.` print as themselves.
Modifiers print in the order ⌃ ⌥ ⌘ ⇧, as the canvas does (`⌘⇧N`).

## 4. Dispatch — `web/src/lib/commands.ts` and `useCommand`

```ts
export function useCommand(id: string, handler: () => void, enabled = true): void
export function dispatch(id: string): boolean   // ran a handler?
export function installKeyListener(): () => void // once, in main.tsx
```

- A module-level map from command id to a stack of handlers. `useCommand`
  pushes on mount / when `enabled` turns true and pops on cleanup; the
  latest registration wins, as `useEscapeLayer` does. The handler is held
  in a ref so a changing identity never re-registers.
- One `window` keydown listener (bubble phase, so a control that handled a
  key keeps it, and after the escape layer's capture listener). For the
  first non-`local` command whose chord `matches` the event: if
  `!whileTyping && isTypingTarget(e.target)` fall through; if a dialog is
  open (`ui.dialog !== null`) and the scope is not `global`, fall through;
  otherwise `preventDefault` and `dispatch`. A command with no enabled
  handler is a no-op and the key falls through.
- The same `dispatch` serves the desktop bridge: `orbitalDesktop.onCommand`
  feeds it the ids the Electron menu sends.
- Escape is not a command. The escape layer keeps it.
- The desktop menu path goes through `dispatchFromMenu(id)`, which applies
  the same open-dialog rule as the key path and ignores an unknown id.

Who registers what:

| Command | Registered by | Handler |
|---|---|---|
| `global.new-session` | `App` | `setDialog('new')` |
| `global.search` | `Sidebar` | focus the search input (also from inside it); disabled while a dialog is open, so ⌘K never pulls focus behind a modal |
| `global.sidebar` | `Sidebar` | `setSidebarCollapsed(!collapsed)` |
| `global.settings` | `App` | `setDialog('settings')` |
| `global.errors` | `App`, `SessionWindow` | `setDialog('errors')` |
| `global.map` | `PageBar` (the header of `/stats` and `/walkthrough/*`; `App` never mounts there) | `window.location.assign(MAP_PATH)` unless already there |
| `global.stats` | `App` (disabled while a dialog is open); `SessionWindow`; `PageBar` | main window: `location.assign(STATS_PATH)` unless already there; detached: `openInMainWindow(STATS_PATH)` |
| `global.up` | `PageBar` | `follow(up)` |
| `global.next-session` / `global.previous-session` | `App` | `select` the neighbour in sidebar order; disabled while a dialog is open |
| `global.next-needs-input` | `App` | `select` the next `needs_input` session; disabled while a dialog is open |
| `map.fit` | `SpaceMap` | `handleFit` |
| `session.interrupt` | `DetailPanel` (when a session is shown) | `setDialog('stop')` |
| `session.clear` | `DetailPanel` | `handleClearClick` |
| `session.end` | `DetailPanel` | `setDialog('end')` |
| `session.pin` | `DetailPanel` | toggle `setSessionPinned` |
| `session.tag` | `DetailPanel` | open the tag `Select` (it gains an imperative `open()` on its ref) |
| `session.model` | `ModelSwitcher` | `setOpen(true)` |
| `session.detach` | `UtilityStrip` (when the detach control is shown) | `detachSession(id)` |

Sidebar order for the cycling commands is `partitionSessions` applied to the
same visible list the sidebar draws (tag filter, search and source filter
applied): PINNED rows then ACTIVE rows. Extract the visible-list computation
from `Sidebar` into a pure function both can call.

`local` rows (composer ⏎ / ⇧⏎ / ⌘⏎, dialog ⏎, question 1–9 / ↑↓ / ⏎, file
viewer ⌥⏎) keep their handlers where they are and change only how they
test the key: `matches(command('composer.send').chords[0], e)` and
`digitFromEvent(e)`. That is what keeps the pane honest — a row exists
only because a chord constant exists, and the constant is what the code
tests.

Keycap hints already printed in the UI (`⌥N` badge on the new-session
button, `Fit view · ⌥F`, `⌘K` in the search field, the ⌘⇧N sentence in
Settings → Sessions) are rendered from `chordLabel(command(id).chords[0])`.

## 5. The Electron menu is generated from the keymap

The renderer owns the keymap; main owns the menu. After the main window's
`App` mounts it sends the menu-worthy commands once:

```ts
orbitalDesktop.setMenuCommands(items)   // { id, label, accelerator, menu, order, registerAccelerator }[]
orbitalDesktop.onCommand(cb)            // main → renderer: run this id
```

- `preload.ts` exposes both. Main accepts `set-menu-commands` from the main
  window only (a detached window sends nothing), validates the payload with
  a pure parser in `desktop/src/lib/appMenu.ts` (`parseMenuCommands`: ids
  are `[a-z]+\.[a-z-]+`, menus are the four names, accelerators are
  non-empty strings; anything else drops the item) and rebuilds the menu.
- `appMenuTemplate({ dev, showMap, commands, run })` gains the list. It
  inserts: a **File** menu (`New session` then the `close` role — the
  `fileMenu` role is replaced because a role's submenu cannot be added to);
  a **Session** menu between Edit and View; the `View` items ahead of the
  reload group; `Stats` and the cycling items after `Map` in **Window**.
  Items are ordered by `order` within a menu. `Map` stays main's own item:
  its click shows the window (as today) and then `run('global.map')`.
- `run(id)` sends `command` with the id to
  `BrowserWindow.getFocusedWindow()`'s web contents, so ⌘. in a detached
  window interrupts that window's session.
- `registerAccelerator` is honoured on Linux and Windows only
  (`electron.d.ts`), so commands with `whileTyping: false` (⌘⌫, ⌘.) are
  listed in the menu without an accelerator; the renderer's listener
  handles the key with the typing guard. `onCommand` is registered once in
  `main.tsx` (a preload listener cannot be removed, so an effect would
  double it under StrictMode), which also covers the stats and walkthrough
  pages.
- `Map`'s command is sent straight to the main window (`runInMain`), not to
  the focused one, because focus may not have moved yet when its click
  runs.
- Until the list arrives, the menu is what it is today. A main window that
  starts on `/stats` or `/walkthrough/*` keeps that menu until the map is
  visited, because only `App` sends the list.

`desktop/test/appMenu.test.ts` covers: the parser, the placement of each
menu, that `Map` still shows the window, that `run` receives the id, and
the `registerAccelerator` rule.

## 6. Settings → Shortcuts

The nav item turns on (`disabled: false`). The section renders from
`keymapGroups(query)`, following canvas A of `Feature - Shortcuts.dc.html`:

- **Header line** in the dialog's title row: `{N} bindings · {S} scopes`,
  mono, muted.
- **Filter field** across the top of the content, placeholder "Filter by
  action or key", auto-focused when the section opens; a muted match count
  (`{shown}/{total}`) at its right end while a query is typed. The filter
  matches the label, the note and the glyph string
  (`chordGlyphs(...).join(' ')`), case-insensitive. No `/` prefix glyph
  (it suggests a key that is not bound) and no "Restore defaults" button
  (nothing can be changed yet).
- **Groups** in `SCOPES` order. Header: title in mono uppercase tracked
  (`text-[10px] tracking-[0.18em]`), followed by the scope's `when` text in
  mono muted. A group with no matching rows disappears, header included.
- **Rows** 40 px min-height, hairline top border, no fill, no hover, not
  clickable (rebinding is not built; a "click to rebind" affordance that
  does nothing is not drawn). Left: label 13 px medium, and the note under
  it in mono 10 px muted when present. Right: the keycaps, right-aligned
  and ragged.
- **Keycap**: one cap per chord, all its glyphs inside a single border with
  a 6 px gap (`⌘ ⇧ N` is one cap, never three). 24 px tall, 6 px radius,
  1 px `rgba(150,205,255,.16)` border on `rgba(150,205,255,.05)`, mono
  11.5 px, `tracking-[0.06em]`, `rgba(220,235,255,.9)`. Word caps are
  lower-case (`esc`). A `gesture` prints as a dashed cap in muted text. An
  alternative chord prints muted after a mono `/`. `Keycap` takes `display`
  as a string or an array of glyphs, so a row's caps keep the per-glyph
  gap.
- **Empty state** for a query with no match: `NO MATCH` in mono tracked,
  and "Nothing bound to that. Try a modifier glyph, or an action word like
  “fit”." beneath.
- **Footer** under the list: "Bindings are read from the live keymap ·
  rebinding lands later", mono 10.5 px muted, hairline top border.

The pane draws every cap with one component (`web/src/ui/Keycap.tsx`); the
sidebar's ⌘K badge and the New session ⌘N badge keep their own smaller
styling and print their chord with `chordLabel`, so the text cannot drift
even though the frame differs.

## 7. Detached windows

`SessionWindow` installs the same key listener and registers `global.errors`
and `global.stats`. `DetailPanel` and `UtilityStrip` register their session
commands there exactly as in the main window, against the window's fixed
session. Commands with no handler in that window (`global.search`,
`global.sidebar`, `global.new-session`, the cycling commands) are no-ops
there. A menu accelerator from the OS reaches whichever window has focus
(§ 5). Menu items whose command has no handler in the focused window
(File → New session, View → Toggle sidebar and the Window cycling items
from a detached window or a page-bar page) stay enabled and do nothing;
⌘, likewise acts only where `App` is mounted. Disabling them per window
would need constant IPC for no gain.

## 8. Testing

Worth a test (they fail for a reason other than someone editing the value):

- `keymap.test.ts`: `parseChord` and `matches` — a QWERTZ-style event
  (`code: 'KeyY', key: 'z'`) matches `meta+z`; `Digit1` with `key: '+'`
  matches `meta+Digit1`; `⇧N` arriving as `key: 'N'` matches
  `meta+shift+n`; an extra modifier does not match; `ctrl+shift+Tab`
  matches only `ctrlKey` (not `metaKey`); `digitFromEvent`;
  `isTypingTarget`; `accelerator`; every `COMMANDS` id is unique and every
  chord parses; no default chord uses a forbidden punctuation key.
- `commands.test.ts`: last registration wins, a disabled handler is
  skipped, the typing guard, the dialog-open rule, `preventDefault` only
  when a handler ran, `dispatch` from the bridge path.
- `keymapGroups` filtering: empty groups drop out, glyph match, note match.
- `appMenu.test.ts` as in § 5.
- Existing tests that assert ⌥N / ⌥F / ⌘[ / `key: '1'` in the question
  card are updated to the new chords.

Not tested: the pane's rendering and keycap styling.

## 9. Documents

- ADR [[cmd-is-orbitals-modifier-and-digits-bind-by-position]] records
  rules 1–3 and 6.
- [[new-session-shortcut-moves-to-option-n]] → `superseded`.
- This spec → `done` when merged.

## 10. Out of scope

Rebinding and its persistence, conflict resolution, import / export, a
printable cheat sheet, a `?` overlay, an ⌥-letter chord family, the cs/en
switch, and any binding for actions the app cannot yet perform (previous
prompt, permission-mode cycling, fold all).

## 11. Implementation order

Each step is one subagent task and leaves the suite green.

1. `web/src/lib/keymap.ts` + tests; `Keycap` component. Nothing wired.
2. `web/src/lib/commands.ts` (`useCommand`, `dispatch`, listener) + tests;
   `installKeyListener` in `main.tsx` for both entry points.
3. Migrate the existing bindings onto the keymap and retire ⌥N, ⌥F, ⌘[,
   the duplicated `isTypingTarget`, and the question card's `e.key` digits;
   re-point the printed hints; update the affected tests.
4. New commands: sidebar toggle, settings, errors, stats, map, cycling,
   next-needs-input, interrupt, clear, end, pin, tag, model, detach
   (including the `Select` imperative `open()` and the extracted
   visible-list function).
5. Desktop: preload bridge, `parseMenuCommands`, `appMenuTemplate` with the
   generated menus, `run` to the focused window, `web/src/lib/desktop.ts`
   half, `App` sending the list; tests.
6. Settings → Shortcuts pane.
7. Docs: ADR, idea status, spec status; `atlas validate`; version bump.
