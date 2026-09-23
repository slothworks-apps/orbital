---
id: one-syntax-palette-for-all-code
title: One syntax palette for all code, including the diff
type: adr
status: in-force
domain: web
related:
  - 2026-09-23-edit-diffs-in-the-transcript
  - the-diff-separates-on-luminance
  - diff-hues-are-content-not-state
  - mode-dots-are-their-own-hue-family
  - 2026-09-19-file-viewer-design
tags:
  - design
  - transcript
---
# One syntax palette for all code, including the diff

## The problem

The transcript's edit diffs had no syntax colour at all — every line was
the row's single ink. Adding it raises a question the product had not had
to answer before, because until now only one surface showed highlighted
code: which palette?

Two candidates, both defensible.

**Shiki's `github-dark-default`.** Already shipped. `lib/highlight.ts`
loads it lazily and `panels/FileViewer.tsx` renders its tokens, so the
file viewer has been painting code in it since the viewer landed.

**The canvas's token palette.** Artboard `20d` of `Feature - Transcript
blocks.dc.html` proposes a different, lower-chroma set — one lightness and
one chroma for every slot, `L 84 · C .075`, varying only in hue:

| slot | canvas |
|---|---|
| keyword | `oklch(82% .085 290)` |
| string | `oklch(85% .075 175)` |
| number | `oklch(86% .075 100)` |
| function | `oklch(84% .075 240)` |
| comment | `rgba(160,190,225,.5)`, italic |

It is chosen to sit inside Orbital's own colour discipline, and it
explicitly avoids red, because `oklch` hue 25 is the `bypassPermissions`
mode dot and [[mode-dots-are-their-own-hue-family]] reserves it:

> Nothing else in the UI may use `oklch(66% .2 25)` or anything near it —
> an error state that borrows it makes the one genuinely dangerous mode
> ordinary.

`github-dark-default`'s keyword colour is `#ff7b72`, which is a red.

## The decision

**Code is painted in `github-dark-default`, everywhere, and the diff uses
it unchanged.** The collision with the reserved bypass hue is knowingly
accepted.

The rule this settles is not "which red" but *where the boundary of
Orbital's colour system runs*. Syntax colour is not Orbital describing its
own state — it is a rendering of someone else's file, the same way the
file's text is. A keyword is red because the grammar says it is a keyword,
not because anything in Orbital is dangerous. Putting that under the same
hue discipline as mode dots and tag pills would mean maintaining a
bespoke theme for every grammar shiki supports, and it would mean the same
file reading in two different colour schemes depending on whether it was
opened in the viewer or changed by an `Edit` — which is the failure mode
that actually costs a reader something.

Three things keep the collision harmless in practice:

- **Placement.** A mode dot is a small, saturated disc on a control. A
  keyword is a word inside a mono code frame. Neither is ever in the
  other's surroundings, which is the same containment argument
  [[diff-hues-are-content-not-state]] made for the diff's own hues and
  [[the-diff-separates-on-luminance]] still makes for the `+n −m` counts.
- **Distance.** `#ff7b72` is a light, desaturated salmon; the bypass dot
  is `oklch(66% .2 25)`, darker and far more saturated. They are near in
  hue and not near in anything else.
- **Redundancy.** Nothing in Orbital is *only* signalled by a mode dot's
  colour; and nothing about a diff row is signalled by a token's colour at
  all.

## What the diff does with it

The diff's own add/remove system is untouched: the sign column is still
the primary channel, the band is still the second, and the row inks from
[[the-diff-separates-on-luminance]] still apply to any row drawn without
tokens. Syntax colour is layered *inside* that, on a different axis:

- **Added and context lines** draw their tokens at full strength.
- **Removed lines** draw the same hues at reduced opacity, which is the
  one dimming rule 20d's table gives. Dimming lowers luminance and keeps
  hue, so a removed keyword still reads as that keyword — and the
  add/remove separation stays a luminance separation, which is what the
  artboard asks the diff's colour to be.

Only opacity is ever applied to a token colour. No token hue is
substituted, anywhere.

## What it costs

[[mode-dots-are-their-own-hue-family]]'s reservation is now a reservation
over *Orbital's own* colours rather than over every pixel on screen. That
is a real narrowing of a rule that was written absolutely, and it should
be read alongside that ADR rather than as a quiet exception to it. The
practical consequence: a future surface that wants red must still justify
itself against the bypass dot, unless it is rendering code.

It also means the five token values in 20d's table are, on this one point,
a design the code declines — and it loses what they were reaching for: a
single lightness and chroma across every slot, so that no token can ever
out-shout the diff band it sits on. `github-dark-default` has no such
discipline. In practice the diff's own bands are luminance
([[the-diff-separates-on-luminance]]) and the tokens are hue, so the two
channels stay separate anyway; that is the reason this is affordable, not
a reason the canvas was wrong.

The rest of 20d is not in dispute and the fidelity pass reconciled against
it in full: the bands, the inks, the sign column, the radii, the hatch and
the `+n −m` counts all come from the artboard.

## What was rejected

- **The canvas's low-chroma token palette.** Above. It would also have
  needed a shiki theme built and maintained by hand.
- **Highlighting the file viewer and not the diff.** The inconsistency is
  the whole problem.
- **Shifting `github-dark-default`'s keyword hue away from red.** A theme
  edited in one hue stops being the theme; and the next grammar that
  reaches for red (an error token, a regex) reintroduces it anyway.
