---
id: 2026-09-17-permission-mode-dots-design
title: Permission mode — colour dots
status: done
type: spec
domain: sessions
related:
  - 2026-09-15-orbital-design
  - mode-dots-are-their-own-hue-family
tags:
  - sessions
  - detail-panel
  - settings
---
# Permission mode — colour dots

**Date:** 2026-09-17
**Visual design:** `Feature - Permission mode dots.dc.html` on the live Claude
Design canvas (project `df77470e-1384-436c-8b25-5e01acfc497f`), artboards `2d`
(in situ), `2e` (parts and states) and `2f` (settings). Read it through the
`DesignSync` MCP; any export under `design/` is stale.

## Why

A session's permission mode is the one setting that says how much the agent
may do without asking. Orbital states it as a string — `acceptEdits` in a mono
chip in the detail panel header, three text cards in the picker — so the
reader has to know the vocabulary before the screen means anything, and the
chip spends 90px of a 450px header restating a word the user chose minutes
ago.

Colour says it in one glance: green is read-only, red never asks. The string
stays available, one hover away, for the times the exact mode matters.

The change also closes a gap against the SDK. `@anthropic-ai/claude-agent-sdk`
ships `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' |
'auto'`; Orbital offers three of them. `auto` — unattended, with a classifier
vetting each command — is exactly the mode a session you walk away from wants,
and it has no way to be picked today.

## What is built

### 1. One descriptor list

`web/src/lib/permissionModes.ts` holds every mode Orbital offers, in order of
escalating autonomy, with both copies of its wording and its dot:

| mode | dot | description | short |
|---|---|---|---|
| `plan` | `oklch(72% .17 148)` | Read-only. Proposes a plan before acting. | Read-only, plans first |
| `acceptEdits` | `oklch(70% .16 255)` | Edits files freely; asks before shell commands. | Edits freely, asks for shell |
| `auto` | `oklch(76% .16 85)` | Runs unattended; a classifier vets each command. | Unattended, vetted commands |
| `bypassPermissions` | `oklch(66% .2 25)` | Never asks. Sandboxed repos only. | Never asks |

Copy and colours are transcribed from artboards `2d` and `2e`.

Today the wording lives in two arrays inside `ModeCards`. The header readout
needs the same strings for its tooltip, and the settings row needs the short
ones; a third copy inside a third component is how the picker and the readout
end up disagreeing about what `auto` does. The list goes to `lib/` and every
surface reads it.

`shortLabel` exists for one mode only — `bypassPermissions` shows as `bypass`
in the 320px settings column — and defaults to `label` elsewhere.

### 2. `auto` becomes a mode Orbital knows

Four edits, no migration:

- `web/src/lib/types.ts` and `server/src/types.ts` both declare
  `PermissionMode`; both gain `| 'auto'`. The two declarations are duplicated
  by design (no shared types package) and have to move together.
- `server/src/api/routes.ts` re-states the union inline in the
  `POST /api/sessions` body type; it gains `auto` too.
- The `permission_mode` column is `text().$type<PermissionMode>()` — a widened
  union needs no schema change, and existing rows keep their values.

The runner hands `permissionMode` straight to the SDK, which already accepts
`auto`.

`default` and `dontAsk` stay out. `default` is the CLI's ask-about-everything
mode, and Orbital always launches a session from a picker where a choice has
been made; `dontAsk` is settings-only in Claude Code and is never picked per
session.

### 3. `ModeCards` — four cards, 2×2, a dot on each

`grid-cols-3` becomes `grid-cols-2` in both variants. The full variant fits
the 740px dialog at two columns; the compact one is already inside a 320px
settings column, where three cards were cramped and four would be unreadable.

Every card carries a 7px dot before its mono label. Today only
`bypassPermissions` has one, in the warning hue, which reads as "this one is
special" rather than as a scale.

Selection is unchanged and stays three channels wide — accent border, faint
accent fill, accent pip top-right — so the choice never rests on the mode dot,
and colour blindness cannot hide it.

### 4. `ModeReadout` replaces the header chip

`ui/ModeDot.tsx` exports two things: `ModeDot`, the bare dot at a given size,
and `ModeReadout`, the 24×22 box that holds one (artboards `2d`, `2e`).

- 5px radius, border `rgba(150,205,255,.2)`, fill `rgba(4,8,16,.5)`, 8px dot.
- `tabIndex={0}` and `aria-label="permission mode: acceptEdits"`, so the mode
  reaches a screen reader as a word. The dot is never the only channel.
- Hover **and** keyboard focus raise the tooltip and brighten the border to
  `oklch(85% .12 205 / .55)`, so the box reads as something you can point at.

`DetailPanel.tsx` swaps `<Badge variant="mode">` for it. That leaves the
`mode` variant of `Badge` with no callers; it is deleted along with its test,
rather than left as a second way to draw a thing that now has one way.

`ClearDialog` keeps printing the mode as text. It is an item in a
"what the new session inherits" list, not a readout of a live session, and a
dot in the middle of a mono sentence would be noise.

### 5. `ui/Tooltip.tsx`

A small primitive, because the app has none and the native `title` cannot
satisfy the design: `title` does not appear on keyboard focus, and it cannot
carry the two-line mono-name-plus-description shape artboard `2d` draws.

- Wraps its trigger, renders the bubble absolutely inside a
  `relative` wrapper — no portal. The header row is not clipped, and a portal
  buys nothing but z-index bookkeeping.
- Bubble per `2d`: 9px radius, `rgba(10,16,28,.96)` fill, border
  `rgba(150,205,255,.16)`, `0 16px 40px rgba(0,0,0,.55)` shadow, max-width
  340px; mono 11.5px title over a 11.5px `rgba(160,190,225,.8)` body.
- Shown on `mouseenter`/`focus`, hidden on `mouseleave`/`blur`.
- `role="tooltip"`, wired to the trigger with `aria-describedby` while open.
  The bubble's first line — the mode name — is `aria-hidden`, because the
  trigger's own `aria-label` already says it; the description is not.
- **Escape is claimed only when the tooltip was opened by keyboard focus.**
  `useEscapeLayer` makes its holder the single recipient of the keystroke, so
  a tooltip that registered on hover would silently eat the Escape meant for
  the dialog under the pointer. A keyboard user has no other way to put it
  away; a mouse user has only to move the pointer.

### 6. Colours stay out of the tag family

Tags are `oklch(80% .13 H)` everywhere (`tagColor` in `lib/types.ts`), and on
the map hue means tag and nothing else. The mode family is deliberately deeper
and more chromatic — `oklch(66–76% .16–.2 H)` — so the two never read as one
signal. No mode dot is drawn on a planet, and no tag dot appears in the
picker. See `mode-dots-are-their-own-hue-family`.

## Out of scope

- **Availability gating.** The canvas renders `auto` and `bypassPermissions`
  disabled when the host session forbids them. Orbital has no way to know that
  today — it would mean reading Claude Code's settings through the SDK and
  exposing the result over the API. All four cards render enabled. `ModeCards`
  already takes a `disabled` prop, so the hook-up stays cheap.
- `default` and `dontAsk` as pickable modes.
- The planet. Hue on the map is tag, and this change does not touch it.
- The permission rules list (canvas `1e`).

## Acceptance

- The picker and the settings row both show four cards in a 2×2 grid, each
  with its dot, and `auto` can be selected and launched.
- `POST /api/sessions` accepts `permissionMode: 'auto'` and the row round-trips
  through `GET /api/sessions`.
- The selected card is unmistakable in a greyscale screenshot.
- The header readout is 24px wide. Hover and keyboard focus both reveal the
  mode name and its description; Escape dismisses a focus-opened one and is
  left alone for a hovered one.
- The readout's accessible name contains the mode name.
- Every dot clears 3:1 contrast against `#05070d`, and no mode dot collides
  with the tag family's lightness/chroma.
- `bypassPermissions` is the only red in the UI.
