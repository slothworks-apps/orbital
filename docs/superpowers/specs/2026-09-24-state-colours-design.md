---
id: 2026-09-24-state-colours-design
title: "Session state labels are colour-coded by urgency, dot-first on the map"
type: spec
status: done
domain: map
related:
  - what-a-session-waits-for-is-a-label
  - state-labels-are-dots-first-on-the-map
tags:
  - web
  - map
  - sidebar
---

# Session state labels are colour-coded by urgency, dot-first on the map

Source: Claude Design, `Feature - State colours.dc.html`, artboards 24a–24e.
Read it through DesignSync; this spec records what was agreed, not the pixels.

## 1. Colour follows urgency, not the word

Four state colours cover seven labels. Colour goes on **state labels**, plus one
planet element: the ripple ring that expands around a planet waiting on the
human. That ring is a state signal, not a tag ring, so it is amber (the user's
call, beyond the canvas). An INTERRUPTED planet no longer gets the ripple at
all; its coral pill says enough, and it is the rare case of a server restart
cutting a turn short, not someone waiting on you. Planet bodies, the other rings, moons, glow and the sidebar's leading
tag dot keep the tag hue, which the user can set to anything, so a state label can sit next to
a planet in its own colour.

| label | token | shape cue (label mode) |
|---|---|---|
| NEEDS INPUT | `--state-input` (= warning, amber) | outline, solid dot, slow breathe |
| INTERRUPTED | `--state-interrupted` (coral, new) | outline, no dot |
| DONE | `--state-done` (mint, new) | outline, no dot |
| WAITING FOR AGENT(S) | `--state-active` (= accent, cyan) | outline, hollow dot, pulse |
| WORKING | `--state-active` | chip keeps its pulsing dot, now cyan instead of the tag hue |
| IDLE, ENDED | `--state-neutral` (muted ink) | unchanged |

- Nothing is filled. NEEDS INPUT is outlined like the rest; its dot breathes
  (slow, fades only partway) instead of blinking.
- Borders are the state colour mixed toward transparent: a lighter alpha on
  the sidebar/detail chips, a stronger one on the map pill over space.
- Shape carries the meaning and colour backs it up. In greyscale every state
  can still be told apart.

## 2. Surfaces

- **Map pill** (per planet): see § 3 for the two modes.
- **Map summary line**: each `N WORD` segment takes its state colour, count
  and word as one token; separators stay muted. NEEDS INPUT carries its
  breathing dot here too. WAITING sessions stay counted in WORKING. A zero
  segment is dropped, as today. INTERRUPTED gets its own segment (24b draws
  it); before, interrupted sessions were counted as DONE.
- **Sidebar row state label**: coloured; NEEDS INPUT is shortened to `INPUT`
  and WAITING shows the moon count (`WAITING · 2`) because the row has room
  for about eleven characters.
- **Detail header state chip**: coloured, full word.

Out of scope: the Question Card's WAITING ON YOU label.

## 3. The map pill has two modes

A setting in Settings → Appearance → MAP chooses between them. **Dot is the
default** (ADR [[state-labels-are-dots-first-on-the-map]]).

- **Label** (24a): the pill shows its dot (if any) and the word, always.
- **Dot** (24e): at rest the pill is a small disc holding only the dot. The
  word slides out when the pointer is over the planet or over the disc, and
  the border strengthens; it slides back when the pointer leaves. NEEDS INPUT
  collapses too — its breathing amber dot and the summary line are how it is
  found.

In dot mode the dot alone has to carry the state, so every state has one:

| state | dot |
|---|---|
| NEEDS INPUT | solid, slow breathe |
| WAITING FOR AGENT(S) | hollow, pulse |
| INTERRUPTED | solid, steady |
| DONE | hollow, steady |

The map keeps room for the pill the mode draws at rest: the full pill in label
mode, the disc in dot mode. A hover-expanded word may overlap a neighbour.

The sidebar, the detail chip and the summary line always spell the word out,
in both modes.

## 4. Acceptance

- Every state is distinguishable in greyscale, in both modes.
- A pill stays readable next to a planet of its own hue, over the strongest glow.
- Label text reaches at least 8:1 contrast on the panel.
- Only NEEDS INPUT and WAITING (and the WORKING chip) animate.
- Switching the setting changes the map immediately, without a reload.
