---
id: 2026-10-27-text-size-design
title: Text size — one setting for the app, its own for the transcript, the system's on the phone
type: spec
status: active
domain: web
related:
  - why-orbital
tags:
  - settings
  - transcript
  - mobile
---
# Text size — one setting for the app, its own for the transcript, the system's on the phone

**Status: active**, agreed in conversation 2026-10-27 from issue #130.

## Problem

Orbital's text is small. On a laptop screen, and on any screen when the
eyes are tired or behind glasses, the session transcript takes squinting.
Issue #130 asks to change the font family and, above all, the font size,
"the most important place is the session detail".

The only way to get bigger text today is the window zoom (View → Zoom In,
⌘+), which enlarges everything: the map, the panels, the spacing, so the
window holds less. What is wanted is bigger letters, not a bigger
window.

macOS has no system text size an app can follow: the Accessibility "Text
size" reaches a handful of Apple apps and is not exposed to Chromium. So on
the Mac the size is Orbital's own setting. The phone does have one
(Android's font size, iOS Dynamic Type), and there Orbital follows it.

## Goals

- The person can make Orbital's text larger on the Mac, in a few fixed
  steps, from Settings.
- The transcript can be set apart: by default it follows the app's size,
  and it can be given its own step — the place people read most can be
  larger than the panels around it.
- On the phone, the text follows the system font size.
- Someone who changes nothing sees exactly what they see today, on the
  Mac, on the phone and in the website's demos.

## Non-goals

- **Font family.** Not settable. Manrope and JetBrains Mono are part of
  how Orbital looks; issue #130's family half is declined.
- **Smaller than today.** The steps only go up.
- **The map's labels.** Labels drawn at a body on the map — planets,
  moons, the limit sun, tag names, in Planets and Archipelago — keep their
  size. They scale with the map's own zoom and the planet size setting,
  and their boxes feed the label layout math in `map/visuals.ts`.
  Everything else on the map's surface is the app and grows with it: the
  Desk theme's session and question cards, and the text laid over the map
  (the state and camera readouts, badge counts).
- **The terminal.** It has its own font size (`TERMINAL_FONT_PX`) and is
  left alone.
- **A keyboard shortcut.** Settings is enough for now; a shortcut may come
  later if the setting turns out to be changed often.
- **An in-app size setting on the phone.** The system setting is the one
  control there.

## Anti-goals

- Spacing must not scale with the text. Padding, gaps, widths and the
  sidebar stay as they are; only letters (and the line height that goes
  with them) grow. Scaling everything is what the window zoom already
  does.
- Text must not be clipped or overflow at any step. *My call:* a box
  whose size exists to hold its text — a badge, a pill, a chip, a button,
  a row of fixed height — grows with the text (a `min-h` instead of an
  `h`, or the same scale); the space between boxes and the icons beside
  the text stay as they are. Many components set a px text size and a
  fixed height on the same element, so each slice includes this pass and
  a visual check at the largest step, not only the class swap.
- Nothing may change for someone at the default step. A refactor that
  shifts a single size by half a pixel at the default is a regression.

## Behaviour

### On the Mac

Settings → Appearance gets two rows:

- **Text size** — the whole app except the map's labels and the terminal.
  Steps: Default 100 %, Medium 112.5 %, Large 125 %, Extra large 150 %.
  A segmented control, each segment its name over its percentage (canvas
  `Feature - Text size` 6a: a tooltip would hide the very number someone
  is choosing by).
- **Transcript text** — "Same as the app" (default), or one of the same
  steps, in a dropdown that shows the size that results ("Same as the app
  125 %"). When set, it replaces the app step inside the transcript; it
  does not multiply with it. The transcript is never smaller than the app:
  steps below the app's are listed but cannot be picked, and if the app's
  step is raised past a saved choice the transcript follows the app, the
  row says so, and the saved choice is kept for when the app's comes down.
- A **sample** under the two rows shows a session line at the app's size
  and a line of transcript at the transcript's, as they are picked.
- A file attachment's type box has a minimum width with side padding
  instead of a fixed width, so a four-letter extension fits at every step
  (6c).

"The transcript" is what is read in a session: the messages and their
markdown and code, tool rows and their outputs, diffs, permission and
question cards, notices, chips, the composer and its completion popup,
and the subagent and task output panels. File and skill viewers opened
from the transcript count as transcript. The detail panel's header (title,
stats, tabs) belongs to the app.

The change applies at once, without a reload, in every window — the main
window and every detached session window.

Both settings are per-device (this Mac only), like `planet_scale` and
`sidebar_width`: a laptop and a desk monitor want different sizes.

### On the phone

The app's text follows the system font size:

- **Android:** the WebView already applies the system font scale through
  `textZoom` by default (nothing in the repo overrides it). To be confirmed
  on a device first; if it holds, Android needs no change, and Orbital
  must not apply the scale a second time. *My call:* if it does not hold,
  Android stays as it is in this work — reading the scale there takes a
  native plugin and a store build — and that becomes an `idea`.
- **iOS:** WKWebView does not follow Dynamic Type on its own. Read it on
  the web side — *my call:* measure an element styled
  `font: -apple-system-body` (17 px at the default size) and derive the
  scale from it, refreshing when the app returns to the foreground. No
  native plugin, so it ships over the air. *My call:* the scale is clamped
  to the Mac's range (the default up to the largest step); below the
  default the phone keeps today's size, and the largest accessibility
  sizes stop at the largest step, so the layout is checked at the same
  bounds as on the Mac.

The default system size gives exactly today's phone layout.

## How (decided)

- Sizes become relative to one scale per scope, not to the `html` root
  font size. Tailwind v4's spacing is rem-based, so raising the root size
  would scale spacing too (an anti-goal).
- *My call:* a CSS custom property, `--text-scale`, set on the root from
  the app setting and set again on the transcript's container when the
  transcript has its own step. Inheritance gives "Same as the app" for
  free. Every text size is `calc(<today's px> * var(--text-scale, 1))`,
  most simply through a Tailwind `@utility` that replaces the
  `text-[Npx]` arbitrary classes one for one, so each site keeps its
  number. px line heights get the same treatment; unitless ones need
  nothing.
- Fixed pixel math that assumes a text size moves to the same scale or to
  measuring: `CompletionPopup` `ROW_HEIGHT_PX`, the detail panel's
  `TITLE_FONT_PX` auto-height, `JumpToBottom`, and any other one the
  builder finds.
- On the phone the same property carries the iOS scale; mobile.css
  overrides (`.message-markdown` at 14 px and the like) go through it too.

## Order

Built as one change, not the two slices first planned. The class swap
(`text-[Npx]` → `fs-N`) turned out mechanical and a no-op at the default
step, so it was done across `web/src` at once; what separates the
transcript from the rest is only the `data-text-scope="transcript"`
marker on its roots. Both rows ship together.

A detached session window hears a change made in the main window's
Settings through a `BroadcastChannel` (`lib/settingsBroadcast.ts`): the
server does not publish a local PATCH to the windows.

## Design

Drawn in Claude Design, `Feature - Text size.dc.html` (6a Settings, 6b the
transcript at Extra large, 6c the parts). The canvas's scope notes say
"desktop only" and "the Desk theme is untouched"; this spec keeps the
phone following the system size and the Desk cards growing with the app,
as agreed before the canvas was drawn.


Where the rows sit and how they look comes from Claude Design. Prompt for
it: *two rows in Settings → Appearance — "Text size" (four steps, default
first, each named in words with its percentage beside it or in a tooltip) and "Transcript text" (same steps plus "Same as the app", the
default); a step change should be visible without leaving Settings,
possibly as a line of transcript text in the existing Appearance preview
(canvas 5a); larger steps only, no font family choice.*

## Scope

- **Who it is for:** anyone who finds the text small — a laptop screen,
  tired eyes, glasses. Common enough to be a plain setting.
- **Where it lives:** on by default as an option beside the old
  behaviour: two rows in Appearance whose defaults are today's sizes. Not
  Labs — nothing about it is experimental for someone who leaves it alone.
- **What someone already using Orbital notices after updating:** two new
  rows in Settings → Appearance. Nothing else.
- **What can be set:** the app's text step and the transcript's text step,
  per Mac. On the phone, the system font size.

## Phone

Built for the phone too, but by following the system rather than adding a
setting:

- The phone shares the transcript components, so slice 1's conversion
  reaches it; the iOS Dynamic Type reading is part of slice 1, the rest of
  `web/src/mobile` part of slice 2.
- No new route, no Mac setting read by the phone, so no allowlist change
  and no `MAC_FEATURES` gate: it works against any Mac.
- Purely web code, so it ships over the air, no store build.

## Versions

- Desktop: minor per slice (a new setting).
- Phone: minor per slice that changes it (follows the system font size).
- Relay: untouched.

## Left to the builder

- The exact step values and their names.
- The utility's name and how the mechanical replacement of
  `text-[Npx]` is done, as long as every default size is unchanged.
- How the iOS scale is measured and refreshed.
- Whether the site's demos need anything (they should not: the default
  scale is 1).
