---
id: the-diff-separates-on-luminance
title: The diff separates on luminance, not hue
type: adr
status: in-force
domain: web
related:
  - diff-hues-are-content-not-state
  - one-syntax-palette-for-all-code
  - mode-dots-are-their-own-hue-family
  - 2026-09-23-edit-diffs-in-the-transcript
tags:
  - design
  - transcript
---
# The diff separates on luminance, not hue

**Supersedes [[diff-hues-are-content-not-state]].**

## The problem

The transcript's edit diffs shipped with a green and a red of their own.
[[diff-hues-are-content-not-state]] argued for them carefully and flagged
its own numbers as a first draft, because no canvas artboard covered diffs
when it was written:

> The values are provisional in one specific sense: this was written before
> any canvas artboard covered diffs.

The artboard now exists — `20d` of `Feature - Transcript
blocks.dc.html`, "EDIT DIFFS — WHAT WE KNOW, SHOWN HONESTLY". It answers
the same question a different way, and the reasoning in its "H · DIFF
COLOUR — WHY LUMINANCE" panel is the reasoning this ADR adopts:

> Green/red is the reflex, but here green is a tag and red is
> `bypassPermissions`. Light-in / shadow-out needs no new hue and survives
> greyscale.

(Artboard ids are per-file. `Feature - IDE bridge.dc.html` also has a
`20d`; always name the file.)

## The decision

**An addition is a raised light band under bright ink. A removal is a sunk
dark band under muted ink. Neither carries a hue.** The `+`/`−` sign column
is unchanged and remains the primary channel.

| role | value |
|---|---|
| addition band | `rgba(200,225,255,.075)` |
| addition ink | `#f2f6fc` |
| addition sign | `#ffffff` |
| removal band | `rgba(0,0,0,.42)` |
| removal ink | `rgba(160,190,225,.56)` |
| removal sign | `rgba(160,190,225,.7)` |
| context ink | `rgba(200,220,245,.62)` |
| context band / sign | none |
| gap (hunk) band / ink | `rgba(150,205,255,.045)` / `rgba(160,190,225,.55)` |
| removed-line token opacity | `.55` |

Three things follow from this that the old hue family could not give us.

**It composes with syntax highlighting.** Syntax colour is itself hue-coded
([[one-syntax-palette-for-all-code]]), and a green band under a red keyword
is two hue systems arguing inside one row. A luminance band is a different
channel entirely, so the two stack instead of competing — which is also why
20d dims only the *removed* line's tokens and leaves added and context
tokens at full strength: the band already did the separating, and dimming
the added line would undo it.

**It settles, rather than narrows, the hue budget.**
[[mode-dots-are-their-own-hue-family]] reserved the bypass red, and
[[diff-hues-are-content-not-state]] had to argue its way past that
reservation and spend a third hue family doing it. The diff body now spends
none. The warning that a fourth family would be hard to find room for goes
away with it.

**It survives greyscale**, which the sign column alone already did and the
bands now do too.

## Where green and red survive

One place: the folded row's `+n −m` skim (20d-G).

| role | value |
|---|---|
| `+n` | `oklch(82% .14 145)` |
| `−m` | `oklch(72% .15 22)` |

These are counts on a row, never ink on a band, so they cannot be read as
the body's add/remove system — which is exactly the containment argument
[[diff-hues-are-content-not-state]] made, surviving into a decision that
otherwise replaces it. 20d-G also gives the reason for these particular
numbers: the previous `+n`, `oklch(78% .13 145)`, sat on top of the
experiments tag's green (`oklch(80% .13 150)`). The new pair clears it.

## What it costs

**The added line is quiet.** A `.075` light band is much less shouty than a
green wash, and on a bright monitor in a bright room it may not read at all
at a glance. 20d anticipates this and ships a documented fallback rather
than leaving the next person to invent one — its `diffPalette` prop's
second option, `violet / teal`: low chroma, on two hues no tag and no mode
uses.

| role | fallback value |
|---|---|
| addition band / ink / sign | `oklch(78% .07 180 / .12)` / `oklch(92% .05 180)` / `oklch(86% .08 180)` |
| removal band / ink / sign | `oklch(62% .09 300 / .16)` / `oklch(82% .06 300)` / `oklch(78% .09 300)` |

Switching to it is a change to `ROW_CLASSES` and `GLYPH_CLASSES` in
`web/src/panels/DiffView.tsx` and nothing else. It would spend a hue family
again, and it would re-open the composition question against the syntax
palette — so it is a fallback, not a preference.

**A dark band on a dark surface is a narrow range.** The removal band is
`rgba(0,0,0,.42)` over the body's `rgba(10,15,26,.9)`; on a surface much
darker than that one it would have nothing left to sink into. The diff body
should keep its own background rather than inherit whatever it is dropped
onto.

## What was rejected

- **Keeping the drafted green/red family.** It predates the artboard, it
  costs a hue family, and it fights the syntax palette.
- **The violet/teal pair, now.** 20d marks it a fallback for a test that has
  not been run; adopting it pre-emptively spends the hue budget for nothing.
- **Hue for the body, luminance for nothing.** Considered and rejected by
  20d itself, and by [[diff-hues-are-content-not-state]] before it under the
  name "going hue-free" — which that ADR called a serious option and turned
  down only because it believed the `+`/`−` glyphs would be carrying the
  information alone. With bands doing it too, they are not.
