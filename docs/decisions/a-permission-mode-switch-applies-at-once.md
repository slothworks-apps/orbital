---
id: a-permission-mode-switch-applies-at-once
title: A permission-mode switch applies at once, without asking
status: in-force
type: adr
domain: sessions
related:
  - a-model-switch-always-asks
  - mode-dots-are-their-own-hue-family
  - an-approved-plan-continues-in-acceptedits
tags:
  - detail-panel
  - permissions
---
# A permission-mode switch applies at once, without asking

## The problem

A session's permission mode was fixed at launch. The detail header showed it
as a dot with a tooltip, and the only way to leave `plan` or enter
`bypassPermissions` mid-session was the approved-plan path. The CLI lets you
cycle modes during a run; Orbital did not.

## What was decided

The header's mode dot is a button that opens a listbox of the four modes
(`web/src/panels/ModeSwitcher.tsx`). A pick is sent to
`POST /api/sessions/:id/permission-mode`, which calls the SDK's
`setPermissionMode` on a running session and writes the row either way, so a
revive resumes in the new mode.

- **No confirmation.** The model switch asks because it forfeits the prompt
  cache ([[a-model-switch-always-asks]]). A mode switch costs nothing and is
  undone by another pick, so a dialog would be friction without information.
- **It applies at once, not from the next turn.** The CLI reads the mode on
  each tool call, mid-turn included; the popover says so.
- **Every session is launched with `allowDangerouslySkipPermissions`.** The
  CLI refuses a switch into `bypassPermissions` unless the session was
  launched in it or with that flag. The flag grants nothing by itself.
- **The Runner mirrors the mode in `attempt.permissionMode`**, because
  `decide()` reads it to wave permission asks through under bypass.
- **Terminal-live sessions get the plain readout.** Orbital cannot reach their
  process — the same rule as the model switch.

## Ruled out

- Confirming only the switch into `bypassPermissions`. The user picked it from
  a list that describes it; the launch picker does not ask either.
- Settling an already-parked permission card when the switch goes to bypass.
  The card is on screen and answers itself; the new mode governs the next ask.
