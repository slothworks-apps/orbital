---
id: settings-drafts-lose-the-last-keystrokes-on-a-quick-close
title: Settings draft fields lose the last keystrokes when the dialog closes within the debounce
status: backlog
type: fix
domain: web
related:
  - 2026-09-30-session-instructions-design
  - 2026-09-21-settings-sections-design
tags:
  - settings
---
# Settings draft fields lose the last keystrokes when the dialog closes within the debounce

## What happens

`web/src/panels/Settings.tsx` holds four fields as local draft state, each
debounced through `DEBOUNCE_MS` (400 ms) before it PATCHes: the default
project directory, the Claude Code executable path, the Claude directory,
and — since this branch — the *Your instructions* textarea. Each field's
effect is keyed on `[draft, open]` and its cleanup runs `clearTimeout` on the
pending timer.

Closing the dialog flips `open` to `false`, which unmounts nothing but does
run that cleanup — so a keystroke typed in the last 400 ms before closing
never fires the `patchAndSet` it was waiting on, and is lost. Reopening the
dialog reseeds the draft from the last saved `settings`, which does not
include it.

This is sharpest for the *Your instructions* field: it is multi-line and
the most likely of the four to be closed right after finishing a thought.

## Why it was not fixed with the feature

The three older fields already behave this way; this branch's textarea only
inherits the existing pattern rather than introducing it. Fixing it is a
change to the shared debounce shape, not to the new field alone, so it is
out of scope for the session-instructions work and deferred here instead.

Found in the final review of the session-instructions branch, 2026-09-30.

## Fix

Flush every pending draft when the dialog closes, for all four fields at
once — a single effect keyed on `open` going false that fires any
outstanding `patchAndSet` immediately — rather than a special case bolted
onto one field.
