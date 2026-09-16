---
id: one-tag-per-session
title: A session wears exactly one tag, picked from a dropdown
status: active
type: adr
domain: sessions
tags:
  - tags
  - detail-panel
---
# A session wears exactly one tag, picked from a dropdown

## The problem

The detail panel's header (canvas 1b) listed **every** tag as a toggle chip
and lit the ones the session held. Two things were wrong with that.

The row grows with the tag list — five tags meant five chips wrapping under a
450px panel, most of them noise. And it advertised multi-tag membership the
rest of the product does not honour: the map groups a session under
`tagIds[0]`, the sidebar takes its hue the same way, and the planet has one
colour. A session could be given three tags and only the first would mean
anything.

`DESIGN-TODO.md` kept the chips deliberately — "the popover picker is a new
interaction, not fidelity work". Canvas 1b has since been redrawn with the
picker, so it is fidelity work now, and it comes with the rule spelled out
under the options: **ONE TAG PER SESSION · SETS PLANET HUE**.

## The decision

A session carries one tag. The header shows it as a hue-filled pill that opens
a menu of every tag; picking one **replaces** the current tag rather than
adding to it.

Three places carry that:

- `ui/Select` gained a `tag` variant (1b's filled pill, inline chevron that
  flips while open) and a `footer` prop for the hint under the options. The
  hint is wired to the trigger with `aria-describedby` rather than being faked
  as an unpickable option.
- `DetailPanel` sends a single id: `PUT /api/sessions/:id/tags` with
  `[tagId]`. The server already turns that into one `manual` row plus a
  `manual_removed` row for every rule tag it displaces, so the pick sticks
  even against a rule that would re-derive the old one.
- `effectiveTagIds` now resolves the `session_tags` rows down to **one** id:
  a manual pick beats a rule-derived tag, and a session with neither falls
  back to the default tag.

## What was NOT changed, and why

`session_tags` stays a many-row table. The origins (`rule`, `manual`,
`manual_removed`) have to be told apart — suppressing a rule tag without
deleting the rule is exactly what `manual_removed` is for — so collapsing the
table to a `sessions.tag_id` column would cost that and buy nothing.

`ApiSession.tagIds` stays an array. It is the wire shape the map, sidebar,
`?tag=` filter and the tag-count badges already read, and every one of them
already takes the first entry. Narrowing the type would be a rename across the
client for no behavioural gain; the invariant is enforced where the value is
produced instead.

`PUT /api/sessions/:id/tags` still accepts an array. It is the generic
replace-the-manual-tags operation, and the client is the thing that now only
ever sends one id.

## Consequences

- A session that already held two tags shows — and keeps — the manual one, or
  the lower-id rule tag if it has no manual pick. Nothing is deleted; the
  extra rows simply stop being effective.
- Tag counts in Settings › Tags & rules become exclusive: each session is
  counted under exactly one tag.
- The popup chrome in `ui/Select` now follows 1b for every caller (5px
  padding, 10px radius, flat `rgba(10,16,28,.96)` fill, rows inset at a 7px
  radius). 1b is the only artboard that draws an open listbox, so the values
  are sourced rather than borrowed from the panel vocabulary — the rules table
  and settings fields inherit it.
- The keyboard-active row keeps its accent tint instead of 1b's hover tint.
  The canvas paints hover and selection identically, which would leave an
  arrowing keyboard user unable to tell which row Enter would commit.
