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

- **The terminal palette** (xterm) keeps its literals.
- **The map on light themes** follows the tokens (`lib/sceneColours.ts` reads
  the resolved tokens once per theme and hands three.js its colours; the
  hole is the darker of `shade` and `ink-50` pressed toward black, so it stays
  the darkest thing on the map; the brightest marks are pure white on a dark
  theme and `ink-50` on a light one). How planets, the hole's halo and the
  tag hues should look on a light sky waits for canvas artboards 1l and 1m.
- **Shadows and gradients** written as arbitrary Tailwind values
  (`shadow-[0_0_8px_rgba(…)]`), and the black and white of drop shadows and
  inset highlights, which may not need a theme at all.
- **Left literal on purpose:** the logo (a brand mark, not chrome), tag hues
  (`oklch(80% .13 <hue>)`, the user's own colours), the archipelago's
  scenery, and the black of the phone's media viewers.
- **Tag hues on light themes.** Mat names and tag counts in the tag hue (L 80%)
  fail contrast on Albedo and Solar Light (canvas flag 6). Tags need a
  lightness per theme before a light theme leaves Labs.
- **Fills that are plain black or white** (`bg-black/30` behind code, a few
  `bg-white/10` chips) and the three tinted stars of the backdrop.

## 4. The themes

Source: Claude Design, `Feature - Colour themes.dc.html`, artboards 1a–1k.
The token values are the canvas's own oklch and live in `theme.css`, one
`:root[data-colours='<id>']` block per theme; `lib/colourTheme.ts` lists them.

| id | name | kind | after |
|---|---|---|---|
| `deep-field` | Deep Field | dark, the default | today's palette |
| `event-horizon` | Event Horizon | dark, near-black, brighter ink | — |
| `albedo` | Albedo | light, for a bright room | — |
| `solar-dark`, `solar-light` | Solar Dark, Solar Light | dark, light | Solarized |
| `molten` | Molten | dark | Monokai |
| `velvet` | Velvet | dark | Dracula |
| `arctic` | Arctic | dark | Nord |
| `ember` | Ember | dark | Gruvbox |
| `slate` | Slate | dark | One Dark |

The canvas first called them Night, Daylight and Contrast (and the light one
Infrared for a while); the shipped names are
Deep Field, Albedo (how much light a body reflects: a pale, reflective sky)
and Event Horizon. All ten ship in the first round.

Decisions taken from the canvas's flags (1b), each a visible change to Deep
Field:

- `ink-900` rises from `#a0bee1` to `#a8c6e9` (oklch 81.6% .06 252), so muted
  text at 60 % passes AA on a panel.
- Captions move from `ink-900` at 45 % to the muted 60 %; no theme could make
  45 % pass.
- Past the critical line the context number is `ink-100` beside the red fill:
  a red light enough to read stops looking critical.

Added with the themes: `shadow` and `highlight` (a light theme cannot shade
with `shade` or light with `ink-50`), and `nebula-a`, `nebula-b`, `star` for
the map backdrop, which on Albedo reads as a star chart. Drop shadows and
inset highlights were moved onto them.

### Mac

Labs → Colour themes turns the feature on. While it is on, Settings →
Appearance gets COLOURS at the top: one dropdown grouped DARK / LIGHT with
each theme's space, panel and accent as dots, and Follow the system, which
takes Albedo while macOS is in light mode and the chosen theme otherwise.
Settings keys `colour_themes_enabled`, `colour_theme`,
`colour_theme_follow_system`. A change repaints in the next frame; the last
painted theme is remembered in `localStorage` so a reload paints it before
settings arrive, and other windows follow through the `storage` event.

## Scope

- **Who it is for:** anyone who wants Orbital in another palette (a light
  room, a contrast need). This change alone is for developers: it is what makes
  a theme possible.
- **Where it lives:** Labs on the Mac; Deep Field stays the default.
- **What someone updating notices:** muted text and captions a little
  brighter, the critical context number in white. Nothing else until Labs →
  Colour themes is on.
- **What can be set:** the theme, and whether it follows the OS's light and
  dark mode.

## Phone

Built for the phone too (canvas 1k). `web/src/mobile` uses the same
`theme.css`, so every theme paints there unchanged. The phone keeps its own
choice on the device (`mobile/platform/colourTheme.ts`), like its
notification rows: Settings → Appearance → Colours opens a pushed list
grouped DARK / LIGHT, and Follow the system splits the row into "In light
mode" and "In dark mode". Pairing does not copy it and nothing syncs in
either direction, so there is no route and no `MAC_FEATURES` gate. The phone
has no Labs; the picker is there for everyone, and Deep Field stays the
default.

The status bar follows the theme through `@capacitor/status-bar`: dark icons
on a light theme, and on Android the bar takes the theme's `space`. That is a
native plugin, so the shell went to 0.9.0 (store build); an older shell
running the newer bundle keeps its dark bar, since the call is skipped while
the plugin is missing. The native launch screen stays Deep Field: a cold
start in a light theme shows it for a moment before the app paints.
