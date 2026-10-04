---
id: the-new-session-dialog-remembers-the-last-launch
title: The New session dialog opens on the last launch, not on the Settings defaults
status: in-force
type: adr
domain: web
related:
  - the-new-session-dialog-loses-its-first-prompt
  - settings-sections-split-by-kind
tags:
  - sessions
  - settings
---
# The New session dialog opens on the last launch, not on the Settings defaults

## The problem

The dialog used to open on the Settings defaults every time: the default
project directory and the default permission mode. Working on one project for
a while meant picking the same directory, mode and tag again for each
session. That is the overhead Orbital is supposed to remove.

## The decision

Each launch writes what was chosen to the settings table, and the next open
starts from it (`lastLaunch` in `web/src/panels/NewSessionDialog.tsx`):

- `new_session_last_cwd`: the directory.
- `new_session_last_mode`: the permission mode.
- `new_session_last_tag`: the tag, **only when it was picked by hand**. It
  applies only in the directory it was picked for; in any other directory the
  tag rules decide, as before. A rule's match is not stored, because the rule
  will give the same answer again next time.

- `new_session_last_claude_dir`: the Claude directory, when two or more are
  configured and the dialog offered the choice. The server stores it from
  `POST /api/sessions` itself, not the dialog, because the phone cannot
  write settings and makes the same choice
  ([[2026-10-04-multiple-claude-directories-design]] § 3). The order is the
  selected planet's directory, then this key, then `default_claude_dir`; a
  removed directory falls through (`openingClaudeDir` in
  `web/src/lib/claudeDirs.ts`, shared with the phone).

The model has no key of its own. `remember_model_per_project` already
preselects the model last used in the directory, and the remembered directory
brings that model with it.

### A selected planet comes first

When a planet is selected as the dialog opens (`openingLaunch`), the
dialog takes that session's directory and its tag instead: the first of its
tags that still exists, so the new planet lands next to the one you were
looking at. The permission mode is still the last launch's, and the model
follows the directory as above.

The planet's tag is not a hand pick. A launch does not store it as
`new_session_last_tag`, unless the user clicks it. Otherwise a tag a rule
gave the planet would become a remembered choice. If the user changes the
directory, the rules decide the tag. If the planet has no tag, the
remembered hand pick applies when the directory matches.

The Settings defaults (`default_project_dir`, `default_permission_mode`) are
still used until the first launch, and whenever a stored value is missing.
After that, the dialog shows the last launch's values instead. They still
apply outside the dialog: the server falls back to them for sessions it
starts without a picker.

## What is ruled out

- **Carrying over `bypassPermissions`.** That mode never asks for permission.
  Remembering it would silently start the next session, maybe in a different
  project, with no permission checks. It falls back to the default mode, so
  bypass has to be picked every time.
- **`localStorage`.** The dialog's state lives in the settings table, the same
  way `settings_last_section` and the panel widths do. That keeps it in one
  place for the browser and the desktop app.
- **A toggle.** The previous choice is always visible in the dialog before
  Launch, so there is nothing hidden to turn off. Add a toggle if the Settings
  defaults turn out to be missed.
