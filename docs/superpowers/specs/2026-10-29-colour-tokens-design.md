---
id: 2026-10-29-colour-tokens-design
title: Colour tokens — every UI colour from one palette, so colour themes can replace it
type: spec
status: active
domain: web
related:
  - 2026-10-01-map-themes-design
  - 2026-09-24-state-colours-design
tags:
  - web
  - mobile
  - theme
---

# Colour tokens

Colour themes (a palette other than today's dark blue: a light one, a
higher-contrast one) need every colour of the UI to come from a small set of
named tokens that a theme can override. Until this change they did not: the
web app carried about 2,900 colours written straight into Tailwind classes
(`text-[rgba(160,190,225,.6)]`), 262 distinct values, and the `@theme` block
held ten tokens used about 660 times.

This is not the map themes of [[2026-10-01-map-themes-design]] (Planets,
Archipelago, Desk). Those change how the map is drawn. A colour theme changes
the palette of everything, the chrome first.

## 1. The rule

- Every colour of the UI chrome is a token in `@theme` in `web/src/theme.css`.
- Tokens are **opaque**. The strength is given where the colour is used, as a
  Tailwind alpha modifier: `text-ink-900/60`, `border-line/14`, `bg-shade/45`.
  A token with alpha baked in would multiply with the modifier and could not be
  swapped by a theme without retuning every caller.
- An inline style or an SVG attribute takes `swatch('line', 0.18)` from
  `web/src/lib/palette.ts`, which returns the same `color-mix()` over the
  token's `var()`. A colour inside a longer string (a gradient, a border
  shorthand) writes that `color-mix()` out.
- CSS outside Tailwind reads the same tokens:
  `color-mix(in oklab, var(--color-line) 18%, transparent)`.
- A colour written straight into a class or a style is a bug to fix, not a
  local choice, unless it belongs to scenery (the nebula and the star fields)
  or to a renderer that cannot read CSS variables (section 3).

## 2. The palette

| group | tokens | used for |
|---|---|---|
| surfaces | `space`, `space-deep`, `shade`, `panel`, `panel-solid`, `raised` | page, panels, overlays under a dialog, gradient tops |
| line | `line` | hairlines, dividers, the faint fills of rows and chips |
| text | `ink-50` … `ink-900` | text, strongest first; `ink-100` is body text, `ink-900` muted |
| accent | `accent`, `sky`, `sky-soft` | the cyan accent and its two blue companions |
| states | `warning`, `warning-soft`, `warning-deep`, `success`, `danger`, `danger-soft`, `danger-pale` | caution, done, destructive, interrupted |

The `--state-*` variables of [[2026-09-24-state-colours-design]] now point at
these tokens.

The old tokens were renamed in the same change: `text-bright` → `ink-100`,
`text-soft` → `ink-300`, `text-muted` → `ink-900/70`, `panel-border` →
`line/14`, and `panel` lost its baked-in 88 % alpha (`bg-panel` → `bg-panel/88`).

### Near-duplicates were merged

Colours within 8/255 per channel of a token were folded into the nearest
one (the export had, for example, both `rgb(200 214 235)` and `rgb(200 215 235)`, and fifteen
near-black overlay tints). A computed-style comparison of the map, the sidebar,
Settings and an open session before and after shows every element identical
except a handful that moved by at most 7/255, which is not visible.

Six one-off colours were left as they were (a single use each). The design
pass decides whether they become tokens or go.

## 3. Not done yet

- **Renderers that cannot read CSS variables:** three.js materials and textures
  in `web/src/map`, canvas 2D and the terminal palette. They need the palette as a TypeScript object, switched
  together with the CSS one.
- **Shadows and gradients** written as arbitrary Tailwind values
  (`shadow-[0_0_8px_rgba(…)]`), and the black and white of drop shadows and
  inset highlights, which may not need a theme at all.
- **Left literal on purpose:** the logo (a brand mark, not chrome), tag hues
  (`oklch(80% .13 <hue>)`, the user's own colours), and the planet's
  `STATE_INPUT_HEX`, which three.js reads.
- **The theme itself:** a `[data-theme="…"]` block overriding the tokens, a
  setting to choose it, and the palette values, which come from Claude Design.

## Scope

- **Who it is for:** anyone who wants Orbital in another palette (a light
  room, a contrast need). This change alone is for developers: it is what makes
  a theme possible.
- **Where it lives:** the token refactor changes nothing anyone sees. The first
  colour theme goes to Labs, beside today's palette, which stays the default.
- **What someone updating notices:** nothing.
- **What can be set:** nothing yet; later, the colour theme in Settings →
  Appearance.

## Phone

`web/src/mobile` uses the same `theme.css` and the same components, so the
tokens reach the phone with the same no-visible-change result. A colour theme
will reach the phone the same way; its setting is per device and needs no
route.
