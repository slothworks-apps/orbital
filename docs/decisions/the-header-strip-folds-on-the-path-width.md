---
id: the-header-strip-folds-on-the-path-width
title: The header strip folds on the measured width of the path cell
type: adr
status: in-force
domain: web
related:
  - 2026-09-23-end-session-design
  - fold-the-header-strip-when-the-branch-joins
tags:
  - web
  - detail-panel
---

# The header strip folds on the measured width of the path cell

Built 2026-09-23 from Claude Design `Feature - Header actions`, artboards
**23c** (forms 4 and 5) and **23d** (motion). Code: `web/src/panels/stripFold.ts`
(the decision, pure), `web/src/panels/UtilityStrip.tsx` (row 1 of the detail
header), `web/src/ui/Menu.tsx` (the ⋯ menu).

## What it does

Row 1 of the detail header has two forms and no others:

- **expanded** — stats · pin · clear · end ‖ detach · collapse, as 23a.
- **folded** — pin · end · ⋯ ‖ collapse. The ⋯ menu lists Session stats
  (with the busy time and cost inline), Clear and start over, a hairline,
  Open in new window. The browser build has no detach, so its menu ends
  before the hairline.

Pin and End never move. The walkthrough icon and the lineage dots are not
part of the six and never fold. A detached window (no detach, no collapse)
folds to pin · end · ⋯.

## The trigger: a ResizeObserver on the whole where-line cell

The idea doc assumed the header had no branch label yet. It does:
`WhereLine` (canvas `Feature - Git worktree` 1f) draws the path, the git
mark and the branch as one `flex: 1` cell. The fold watches that cell —
path and branch together, which is what 23d asks for ("fold when path +
branch would go under 120 px").

- Fold when the cell would be narrower than `FOLD_MIN_PATH_PX` in the
  expanded form; expand once it would clear that by `FOLD_HYSTERESIS_PX`.
  Both edges are judged on the width the cell would have **expanded**, so it
  does not matter which form was measured. `stripForm` does that arithmetic
  from the strip's known button and gap widths; one measurement is enough.
- **Measured, not derived from the panel width.** Deriving the cell from
  `panelWidthPx` minus a fixed chrome figure was the other option, and it is
  what `WhereLine` already did (`ROW_CHROME_PX`). It was already wrong: the
  strip varies by session (walkthrough, lineage dots, stats as a button or a
  bar, a terminal session without Clear or End), so the constant
  under-counted the real strip and the path was clipped mid-character. A
  measurement is exact whatever the strip holds. `WhereLine` now splits its
  text on the same measured width, so the path grows into what a fold gives
  back, and the constant is left as the fallback for an unmeasured row.
- The cell is `flex: 1`, so its width never depends on the text inside it;
  measuring it and re-splitting the text cannot loop.

## Smaller choices

- **Only worth folding when the ⋯ replaces two or more buttons.** A strip
  where stats is the only folding button (a terminal session in the
  browser) would trade one icon for a ⋯ of the same size. `isFoldable`.
- **Leaving buttons stay mounted.** Their seat animates to width 0 and is
  then `inert` and `aria-hidden`: out of the tab order and the accessibility
  tree, and still there for the expand to grow back.
- **Holding the form.** 23d wants no motion while a tooltip or the menu is
  open. A tooltip only rises under the pointer or on focus, so the strip
  holds while the pointer or focus is inside it, or the menu is open. That
  also keeps a button from sliding out from under a pointer about to press
  it. The held decision is taken with the latest width when the hold ends. A
  fold that is running also holds: mid-fold the cell sits between its two
  widths.
- **First paint.** A new session or a different set of buttons decides its
  form in a layout effect, with transitions off, before the browser paints.
- **Detach keeps a 10 px margin, not 23d's 6.** 23d's demo strip is a flat
  row that puts detach 6 px from End. 23a and 22a, which is how the expanded
  strip is built today, put 10 between End and the panel pair and 6 inside
  it. The expanded form stays as built; detach animates 10 → 0.
- **The menu** is `MenuButton`, the sibling of `ui/Select` for actions:
  same portalled shell (`POPUP_SHELL`, now shared), same positioning, same
  escape layer and outside-press dismissal. It moves focus into its rows
  (the WAI-ARIA menu button pattern), where `Select` keeps focus on the
  trigger.
- **No shortcuts in the menu.** 23c prints ⌘K beside Clear and ⌘⇧N beside
  Open in new window. Neither exists: ⌘K is the sidebar's search, and
  nothing binds ⌘⇧N. The hints are left out.
- **No tooltip on ⋯.** The menu under it names every row, and a bubble would
  hang where the menu opens.

## With the pull request and line changes after the branch (2026-09-30)

Canvas `Feature - Branch status` 1h puts the strip's fold third in the
where-cell's fold order: the path yields to its leaf, split collapses to the
total, *then* the strip folds, and only after that is the branch cut. Spec:
[[2026-09-30-branch-pr-and-line-changes-design]]. Code:
`web/src/panels/whereFit.ts`.

- **The fold is still `stripForm` on the measured cell, with a reserve taken
  off first** (`whereFoldReservePx`): the #PR and the total as drawn at that
  step, plus whatever the path at its leaf and the whole branch need beyond
  `FOLD_MIN_PATH_PX`. The strip therefore folds exactly when the row no
  longer fits whole at the total — the canvas's own rule, and its cost
  statement holds: at the default width a normal feature branch with both on
  folds, PR only or lines only does not.
- **Not taken: the shipped threshold alone.** Subtracting only the suffixes'
  width and keeping `FOLD_MIN_PATH_PX` as the trigger folds far later than the
  canvas, so a normal feature branch is cut before the strip folds — the
  order reversed.
- **Nothing after the branch: the reserve is zero**, so both off, or a branch
  with nothing to show, fold exactly where they did before.
- **A change of the reserve is judged after the suffixes' fade.** A suffix
  that appears or goes fades on the branch's clock; the strip locks its
  decision for that long and then decides, so the row never folds mid-fade.
