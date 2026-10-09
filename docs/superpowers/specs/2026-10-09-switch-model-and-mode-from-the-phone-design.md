---
id: 2026-10-09-switch-model-and-mode-from-the-phone-design
title: Switch a session's model and permission mode from the phone
type: spec
status: done
domain: remote
related:
  - switch-model-and-mode-from-the-phone
  - a-model-switch-always-asks
  - a-permission-mode-switch-applies-at-once
  - the-phone-may-do-what-the-mac-may
  - 2026-10-05-mobile-next-design
  - desktop-vs-phone-feature-map
tags:
  - mobile
---
# Switch a session's model and permission mode from the phone

Canvas 9b draws the session header's second row with a model chip
("Sonnet ▾") and the permission mode's dot in a 28 px box, both buttons.
Until now the phone drew them as plain labels. This makes them do what the
desktop's `ModelSwitcher` and `ModeSwitcher` do. Neither sheet is on the
canvas; both are built from the phone's existing sheet parts.

## Behaviour

- **Mode.** The dot box opens a bottom sheet headed
  `PERMISSION MODE · APPLIES NOW` with 9d's four cards (`ModeCards touch`).
  A tap applies at once and closes the sheet, without asking
  ([[a-permission-mode-switch-applies-at-once]]). All four modes are
  offered, `bypassPermissions` included ([[the-phone-may-do-what-the-mac-may]]).
- **Model.** The chip opens a bottom sheet headed
  `MODEL · APPLIES FROM NEXT TURN`: the session's own account's catalog as
  rows in the ⋯ sheet's geometry, each with its blurb, the current one
  tinted and ticked as in CHANGE TAG, and the desktop's footer ("Context is
  kept…"). Tapping another model swaps the sheet to a confirm (eyebrow
  `MODEL SWITCH`), whose words are the desktop dialog's
  (`modelSwitchCost` in `web/src/lib/models.ts`): every switch asks
  ([[a-model-switch-always-asks]]). Tapping the current model closes it.
- **Both** write the store first and put the old value back, with the
  composer's error line, when the request fails, as the desktop does.

## When they stay labels

The chip and the box lose their caret and their button when:

- the session is live in a terminal (`isReadOnly`): Orbital cannot reach its
  process, the desktop's rule;
- the Mac is asleep: the request would fail, and the header reads as of the
  last sync;
- for the model only, the catalog is empty: there is nothing to switch to.

An ended Orbital session switches as on the desktop: the row is written, and
the session resumes in the new model or mode.

## The phone

This is the phone's half of a desktop feature. Both routes,
`POST /api/sessions/:id/model` and `POST /api/sessions/:id/permission-mode`,
were already on the allowlist (`server/src/remote/allowlist.ts`), and the
catalog comes through `GET /api/models`, so the server is unchanged. The
desktop changes only in where its confirm text lives.
