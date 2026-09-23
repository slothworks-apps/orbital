---
id: 2026-09-18-transcript-folding-design
title: Transcript folding — tool runs and command expansions collapse
status: done
type: spec
domain: web
related:
  - fold-tool-runs-and-skill-prompts
tags:
  - detail-panel
  - transcript
---
# Transcript folding — tool runs and command expansions collapse

Canvas: `Feature - Transcript folding.dc.html` (artboards 6a–6d). Prose is
the signal; machinery is available, not displayed. Two folds, agreed in
chat on 2026-09-18 (the owner: tool calls matter in ~1% of reads — a trace
plus a click is enough).

## Fold 1 — a run of tool calls (web only)

`groupToolRuns` already builds the group; this collapses its rendering.

- **≥ 2 consecutive calls** fold behind one header row (6b):
  `▸ ⚙ 12 tool calls · Read ×6, Bash ×4, Edit ×2`. A single call keeps
  today's `ToolRow` — it already is a one-line trace.
- Header string: kinds sorted by count desc then first appearance; over
  three kinds, top three + `+2 more`; `×n` only when n > 1; singular never
  occurs. Pure helper `summarizeToolRun`, unit-tested.
- **Live run** stays folded; the one unfinished call (no `tool_result`
  yet, same predicate as `openToolUse`) renders beneath the header as a
  normal row with an empty caret slot — the run's leading edge, not a
  child. Right slot says `running`. When it finishes it folds into the
  count and the next unfinished row takes its place.
  - **The leading edge holds the latest call, finished or not** (amended
    2026-09-23). Keying the row on "the unfinished call" made it vanish at
    every boundary between two calls — one finished, the next not yet
    arrived — and reappear a moment later; that shrink-and-grow was the
    jump Tomin kept seeing. Now a run that is the transcript's last group
    while the session is `working` shows its LAST call beneath the header.
    Unfinished, it reads as before (`running`, `…`, pulsing ⚙). Finished,
    the same row stays in place with the tool name, salient input and the
    call's duration when there is one; the header's right slot drops
    `running`. Still a plain trace with an empty caret slot, never an
    expandable `ToolRow`. The row leaves only when the run stops being the
    leading edge: a non-tool group follows it, or the turn ends — then it
    folds to header-only as before. A run that is not last, or in a session
    that is not working (history, ended, reload), shows no live row at all.
    Pure helper `leadingEdgeItem(items, isLastGroup, turnLive)`,
    unit-tested. A single call is still a plain `ToolRow`; the open stack
    still replaces the row rather than standing beside it.
- **A run containing a failed call auto-opens** and the right slot says
  `1 failed` (`{n} failed` when more). Auto-open sets the DEFAULT state
  only — a manual toggle always wins, in both directions. Requires
  `isError` — see wire shape below.
  - **The default is frozen at the group's first render** (amended
    2026-09-22). Recomputing it meant a call that failed while you were
    reading threw its run open under your eyes and shoved the rest of the
    transcript down the page — the largest unasked-for jump in the panel.
    A run whose failure is already in the history when it first renders
    (a reload, scrolling back) still opens, which is what this bullet
    asks for; what stops is the live flip. Nothing is hidden meanwhile:
    the right slot says `n failed` either way.
- Expanded = today's 4px stack, unchanged rows. Open header keeps border
  `rgba(150,205,255,.18)` / fill `rgba(150,205,255,.05)`; caret animates
  `.16s ease` (one `▸` glyph rotated 90°, never swapped in markup).
  - **The canvas's height ease is back** (amended 2026-09-22) — it did
    read as a pop, which is the condition this bullet left for revisiting
    it. It runs at the caret's `.16s` rather than the canvas's `.22s`, so
    the arrow and the stack finish together instead of reading as two
    events. The travel is `grid-template-rows: 0fr -> 1fr`, the one way to
    transition to a height nobody has measured. Folded rows still leave
    the DOM — `usePresence` holds them for the closing pass and then
    removes them — so the live-run predicate and the tests still key on
    absence; a test asserting a fold now awaits it rather than reading it
    in the same tick.
- Hover: border `.22`, fill `.07`, right slot swaps to the verb
  (`expand` / `collapse`). Focus: accent ring `oklch(85% .12 205 / .7)`.
  The whole row is the hit area (a real `<button>`).
- Open state: `Set<groupKey>` in `Transcript` component state, key = the
  group's first message id (stable while streaming appends). Reset on
  session switch is accepted.
- Metrics (6d): row 7px/10px padding, 30px tall, radius 7, mono 11.5px,
  caret slot 8px, stack gap 4px.

## Fold 2 — a command expansion in a user turn

- **Parser owns the split** (`server/src/transcript/parser.ts`):
  `splitUserText(text)` over the existing `NOISE_BLOCK` → the human text
  (what remains outside the tags, trimmed) plus the machinery. Applied in
  BOTH producers — `entriesToMessages` (indexed) and `sdkToChatMessages`
  (live WS) — so a live turn folds the same as a reloaded one. Tag
  contents are never re-parsed.
- **Wire shape** — `ChatMessage` (server `types.ts` + web `lib/types.ts`,
  kept field-for-field in sync) gains:
  - on user messages: `command?: { name: string | null; body: string;
    blocks: number }` — `name` verbatim from `<command-name>` including
    the slash, `body` the raw tag blocks joined in order, `blocks` how
    many there were (for the `machine context ×3` chip label).
  - on tool_result messages: `isError?: boolean` from the block's
    `is_error` (both producers).
  Nothing is thrown away: expanded renders `body` verbatim.
- **Chip** (6c): under the bubble, right-aligned, 6px gap; 26px tall,
  padding 5px/10px, border `rgba(150,205,255,.14)`, no fill. Label
  `/{name} · {n} lines` (name ink `#e8eef8`); unnamed → `machine context`
  in muted row ink, `×{blocks}` when blocks > 1. Line count = `body`
  lines after tag stripping, trailing blanks dropped.
- **Nothing typed** → no empty bubble; the chip is the whole turn (26px,
  not 70).
- **Expanded**: `body` as a mono `<pre>` — 10.5px/1.6 on
  `rgba(4,8,16,.55)`, `white-space: pre-wrap`, left-aligned (it is a
  file, not speech), `max-height 168px` with its own scroll. Markdown
  never parsed. Open chip: border `.3`, fill `.14`, ink `#e8eef8`.
- Open state per message id, component state in `MessageView`.
- `cleanTitle` and the sidebar are untouched.

## Out of scope (canvas drew them; today's data can't)

- Per-row and per-run **durations** — live messages carry no timestamps
  (`sdkToChatMessages` sets none), so the numbers would only exist after
  a reload. A future round can add timestamps to the live path first.
- `exit 1` / `+41 −18` badges on individual rows — an upgrade to
  `ToolRow` itself, separate from folding.

## Testing

- Server: `splitUserText` (named command, unnamed reminder, multiple
  blocks, nothing typed, no tags at all, unclosed tag at EOF), both
  producers emit `command`/`isError`.
- Web: `summarizeToolRun` (sorting, `+n more`, `×n` rules); Transcript —
  folded by default at ≥2, single row unchanged, click expands, live run
  shows the unfinished row, failed run auto-opens; MessageView — chip
  renders, chip-only turn has no bubble, expand shows verbatim `<pre>`.
