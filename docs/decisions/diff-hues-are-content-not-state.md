---
id: diff-hues-are-content-not-state
title: Diff hues are content, and a third hue family
type: adr
status: superseded
domain: web
related:
  - the-diff-separates-on-luminance
  - 2026-09-23-edit-diffs-in-the-transcript
  - mode-dots-are-their-own-hue-family
  - one-syntax-palette-for-all-code
tags:
  - design
  - transcript
---
# Diff hues are content, and a third hue family

> **Superseded by [[the-diff-separates-on-luminance]] (2026-09-23).** The
> canvas artboard this ADR was written without — `20d` of `Feature -
> Transcript blocks.dc.html` — separates the two sides on luminance instead
> of hue, and the code follows it. The diff body now spends no hue family at
> all. Kept because the reasoning below is what the successor was argued
> against, and because one piece of it survives: the `+n −m` skim keeps a
> green and a red, for the containment reason given here.

## The problem

Orbital's colour rule started as *hue means tag*, and
[[mode-dots-are-their-own-hue-family]] already split a second family off
it for permission modes, with a standing warning attached:

> `bypassPermissions` also claims red for itself. Nothing else in the UI
> may use `oklch(66% .2 25)` or anything near it — an error state that
> borrows it makes the one genuinely dangerous mode ordinary.

A diff wants green and red. That is a third thing hue would mean, and the
red end of it sits near the one hue the product has explicitly reserved.

Going hue-free was a serious option: signs and washes only, no colour at
all. It fits the stated discipline exactly, and the `+`/`−` glyphs do carry
the information on their own.

## The decision

The diff gets a green and a red, as its own family, on the same three axes
the mode ADR used to keep two families apart.

| role | value |
|---|---|
| addition ink | `oklch(88% .07 145)` |
| addition sign | `oklch(78% .13 145)` |
| addition wash | `oklch(78% .11 145 / .10)` |
| removal ink | `oklch(87% .07 22)` |
| removal sign | `oklch(74% .14 22)` |
| removal wash | `oklch(74% .12 22 / .10)` |

**Lightness and chroma.** The inks sit at lightness ~.87 and chroma ~.07 —
far lighter and far flatter than the mode family's `.66–.76 / .16–.2` and
than the tag family's fixed `.8 / .13`. The signs are the most saturated
part and still stop below the mode family's chroma. Nothing here is within
reach of `oklch(66% .2 25)`.

**Placement.** A diff hue appears only inside a diff body, and in the
`+n −m` skim on the row that owns it. Never as a dot, never on the map,
never in a mode control, never on a status. This is the same rule that
keeps tags off the panel controls and modes off the sky.

**Redundancy.** The sign in the gutter is the primary channel and the wash
is the second one. A reader who cannot separate the two hues reads the
diff from the `+` and the `−` alone. Neither hue is ever the only thing
saying what a row is — which is what makes this *not* a third vocabulary
to learn, unlike the mode colours, which do have to be memorised.

## Why not hue-free

Because green-and-red for added-and-removed is not a vocabulary Orbital
would be teaching. It is the one colour convention every user of this
product already knows from every other tool they have open, and a diff
that declines to use it is slower to read for no gain. The rule the
product actually holds is *state is carried by motion, never by hue* — and
a diff is not state. It is content: a fixed, historical fact about one tool
call, which never changes, never animates, and never appears anywhere a
status could be confused for it.

## What it costs

A third family narrows the space left for a fourth. If custom tag colours
ever ship they must clamp to the tag family's lightness and chroma — the
mode ADR already says this, and the diff family makes it a little more
load-bearing.

It also leaves a loose end that predates this decision: `lib/usage.ts` and
`panels/Settings.tsx` already paint with `oklch(72% .17 25)`, which is
nearer the reserved bypass red than anything here is. That is worth
tidying, and is not tidied by this change.

The values are provisional in one specific sense: this was written before
any canvas artboard covered diffs. The *reasoning* above is the decision;
the six numbers are this decision's first draft of it, and a design pass
may replace them as long as the three axes hold.

**Resolved, 2026-09-23.** That pass ran. Artboard `20d` of `Feature -
Transcript blocks.dc.html` separates added from removed on luminance rather
than on hue, and the code now follows it, so **superseded** is the answer:
none of the six numbers above survives in the diff body. See
[[the-diff-separates-on-luminance]] for the values that replaced them and
for the one part of this decision that did survive — the `+n −m` counts,
which keep a green and a red on 20d's own instruction, at values chosen to
clear the experiments tag.

Separately, the *syntax* colours inside a diff row were never this
decision's six numbers. They are shiki's, by
[[one-syntax-palette-for-all-code]]; this ADR's hues were the row inks,
signs and washes, which tokens never touch.
