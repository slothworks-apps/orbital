---
id: 2026-09-20-pinned-sessions-design
title: Pinned sessions — keep a session on the map
status: active
type: spec
domain: sessions
tags:
  - server
  - web
  - sidebar
  - map
---
# Pinned sessions — keep a session on the map

Canvas: `Feature - Pinned Sessions.dc.html` (artboards 4a–4e; the source
of truth for every visual value not repeated here). The pin glyph is
variant D "anchor ring" — provisional per 4e, so build it as one small
shared component that can be swapped once.

A handful of ended sessions are reference material — the release timer
(`map_release_ended_after_minutes`) keeps eating them. A pin is a
per-session, manual exemption from that timer. Pinning changes
*lifetime*, not appearance: the map does not change, a pinned planet
renders exactly like any ENDED planet.

## Rules (canvas brief, artboard header)

- Two entry points, one state: the detail-panel header toggle (4b) and
  the sidebar row action (4c). Toggling in either surface updates the
  other within a frame; state survives restart.
- Pinned sessions are exempt from the release timer indefinitely; no
  pin expiry, no pin count limit, no new setting.
- The sidebar gets a third section: **PINNED · ACTIVE · HISTORY**, in
  that order. A pinned session appears under PINNED only — never in two
  places. PINNED keeps pin order (oldest pin first); the HISTORY sort
  control keeps applying to HISTORY only.
- Live sessions can be pinned: they move to PINNED, keep their blinking
  dot, 600 weight and WORKING/IDLE label; the pin has no effect until
  they end.
- **Manual gesture wins.** Dragging a pinned planet into the corner
  hole unpins and absorbs it — no confirm, no block. The absorption
  toast reads `{title} absorbed · pin removed`, and its Undo restores
  both the planet and the pin.
- Pinning an absorbed session (from the sidebar) pulls it back onto the
  map as ENDED.
- The Declutter `N ENDED` toggle still hides pinned planets — declutter
  is a view filter, pinning is a lifetime rule.
- Accent `oklch(85% .12 205)` only, never a tag hue.

## Server

- `sessions.pinned_at` — nullable integer ms, `null` = not pinned
  (same shape as `map_dismissed_at`).
- `PUT /api/sessions/:id/pinned` with `{ pinned: boolean }` — stamps
  `pinned_at` with now / clears it; 400 on a non-boolean, 404 on an
  unknown id; broadcasts the session upsert, all per the existing
  `PUT /:id/dismissed` route.
- The two stamps never coexist: `pinned: true` clears
  `map_dismissed_at` (that is what pulls an absorbed session back);
  `dismissed: true` clears `pinned_at` (manual gesture wins). Activity
  clearing `map_dismissed_at` leaves the pin untouched.
- `GET /api/sessions` orders pinned rows first (`pinned_at` ascending),
  then the rest by `last_at` descending as today. Pinned rows therefore
  always arrive with the first page regardless of age, and the
  sidebar's `offset: visible.length` paging arithmetic stays valid
  because client accumulation matches server order.
- `pinnedAt: number | null` joins the API session shape.

## Web

- `absorptionFor` precedence (store.ts): live status → `none`;
  `mapDismissedAt` stamp → `releasing`/`absorbed` (unchanged — the
  stamp only exists while unpinned); `pinnedAt != null` → `none`;
  otherwise the timed release as today.
- `api.setSessionPinned` + optimistic store action modelled on
  `setSessionDismissed`; pinning optimistically clears
  `mapDismissedAt` locally to mirror the server.
- Sidebar: PINNED section above ACTIVE, count in accent. Row layout is
  shared by all three sections: the pin slot is **always** present in
  the flex row at 18×18 with the row's `gap:10px` — only its opacity
  and chrome change (values in 4c), so nothing reflows on hover and
  row height is identical in all states.
- Detail panel: 28×28 pin toggle left of ⌫ and ×, states per 4b,
  `aria-pressed`, keyboard reachable. Tooltip per 4d: same shell as
  the permission-mode tooltip, 400 ms delay, appears on hover and on
  keyboard focus. The button is the only pinned indicator — no status
  chip; the panel footer carries the wording.
- Strings (4d table): `pin.tooltip`, `unpin.tooltip` (interpolates the
  current setting value; when the setting is `never` the body must not
  promise a release — pick a short variant), `pin.aria`,
  `panel.foot.pinned`, `panel.foot.unpinned` (ended sessions get a
  footer line with the release countdown), `settings.clause` (one
  clause appended to the release row description: "— pinned sessions
  are never released."), `drag.toast`.

## Tests

Worth writing (per repo test policy): the `pinned` route including the
mutual stamp clearing and the list ordering; `absorptionFor` with a
pin; the sidebar's three-way partition if it lands as a pure function.
Not worth writing: pixel values, glyph geometry, tooltip delay.

## Acceptance (artboard brief)

- A pinned ended session is still on the map after the release interval
  elapses twice.
- Pinning a row moves it into PINNED immediately; unpinning returns it
  to ACTIVE or HISTORY in its sorted position.
- Hovering a HISTORY row reveals the pin action with zero movement of
  title, path or timestamp.
- Dragging a pinned planet into the hole absorbs it and clears the pin.
- Toggle reachable by keyboard, `aria-pressed` reflects state, tooltip
  mirrors the label.
