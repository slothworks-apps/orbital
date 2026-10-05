---
id: switch-model-and-mode-from-the-phone
title: Switch a session's model and permission mode from the phone
status: backlog
type: idea
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - mobile-follow-ups
tags:
  - mobile
---
# Switch a session's model and permission mode from the phone

Canvas 9b draws the session header's second row with a model button
("Sonnet ▾"), a permission-mode button (the mode's dot in a 28px box) and a
`⋯` button on the title row. The phone draws the model and the mode as plain
labels and leaves `⋯` out: tapping them would promise something the phone
does not do.

Both routes are already on the phone's allowlist
(`server/src/remote/allowlist.ts`: `POST /api/sessions/:id/model` and
`/permission-mode`), so the work is the phone's UI only:

- a bottom sheet listing the catalog for the model, with the desktop's
  "takes effect from the next turn" note (`panels/ModelSwitcher.tsx` holds
  the rules; its popover and keyboard shortcut are desktop-only);
- the four mode cards (`ui/ModeCards` with `touch`) in a sheet for the mode;
- deciding what `⋯` holds — the canvas does not say. Candidates: rename,
  stop, open on the Mac.

Once built, give the header chips back their caret and their buttons.
