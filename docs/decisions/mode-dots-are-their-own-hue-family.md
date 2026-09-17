---
id: mode-dots-are-their-own-hue-family
title: Permission mode dots are a separate hue family from tags
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-17-permission-mode-dots-design
  - one-tag-per-session
tags:
  - design
  - tags
---
# Permission mode dots are a separate hue family from tags

## The problem

Orbital had one rule about colour, and it was clean: **hue means tag**. Every
tag picks a hue, `tagColor(hue)` renders it as `oklch(80% .13 H)`, and the
planet's atmosphere ring, the sidebar dot and the working badge's border all
paint with it. Session *state* was expressed by motion and lightness — spin,
blink, ripple, a white core for needs-input — never by choosing a different
hue.

Giving permission mode a colour breaks that rule. A green dot for `plan` and a
red one for `bypassPermissions` is a second thing hue can mean, and the two
systems sit within a few hundred pixels of each other: the detail panel header
carries the session's tag hue in its status badge and, now, the mode dot right
beside it.

The options were to keep mode colourless (a chip with a word, which is what it
was, and what the design set out to replace), to fold mode into the tag
palette by reserving four hues, or to give mode its own visibly different
family.

## The decision

Mode dots get their own family: **`oklch(66–76% .16–.2 H)`** — lower
lightness, higher chroma than the tag family's fixed `oklch(80% .13 H)`.

| mode | dot |
|---|---|
| `plan` | `oklch(72% .17 148)` |
| `acceptEdits` | `oklch(70% .16 255)` |
| `auto` | `oklch(76% .16 85)` |
| `bypassPermissions` | `oklch(66% .2 25)` |

Two placement rules keep the families from ever having to be told apart by
memory:

- **A mode dot is never drawn on the map.** The planet, its rings and its core
  stay tag-hued. A session's autonomy is a property of the panel you opened,
  not of the sky.
- **A tag dot never appears in a mode control.** The picker, the settings row
  and the header readout draw mode colours only.

So the two families are separated on three axes at once — lightness, chroma
and where they are allowed to appear — and any single one of them is enough to
resolve an ambiguity.

Reserving four tag hues for modes was rejected: it would have made the mode
colours hostages of the tag palette (rename a tag to that hue and the meaning
collides), and it would have put mode colour on the map by construction.

## What it costs

Someone reading the product for the first time now has two colour vocabularies
to learn instead of one. The mitigation is that mode colour is never the only
channel — the picker keeps the mono mode name on every card, and the header
readout carries the name in its `aria-label` and its tooltip — so the second
vocabulary is optional knowledge, not a prerequisite.

It also puts a standing constraint on the tag palette: **tags stay at
lightness .8 / chroma .13.** A future "custom tag colour" feature that let a
user pick an arbitrary OKLCH triple could land a tag inside the mode family
and undo this. If that feature is built, it must clamp to the tag family's
lightness and chroma and vary only hue.

`bypassPermissions` also claims red for itself. Nothing else in the UI may use
`oklch(66% .2 25)` or anything near it — an error state that borrows it makes
the one genuinely dangerous mode ordinary.

The conventions card in `Orbital.dc.html` still says hue is for tags only. It
needs the split added to it.
