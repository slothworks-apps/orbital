---
id: 2026-10-30-new-session-directory-search-design
title: New session — the directory field searches every directory a session ran in
type: spec
status: done
domain: web
related:
  - why-orbital
  - the-new-session-dialog-remembers-the-last-launch
  - browse-opens-the-native-folder-picker
tags:
  - sessions
---
# New session — the directory field searches every directory a session ran in

**Status: done**, agreed in conversation 2026-10-30, built from the canvas
`Feature - Directory suggestions` (1a–1d).

## Problem

The desktop New session dialog offers four RECENT chips under the
PROJECT DIRECTORY field. Someone working on more projects than that
reaches for Browse… and walks the Finder dialog every time a project
falls off the four. `GET /api/projects` already answers up to
`PROJECTS_LIMIT` directories, newest first; the dialog drops all but the
first four.

The phone solved the same problem in 9d: its directory field is a search
over that list (`filterDirectories` in `web/src/mobile/newSession.ts`).

## Behaviour

- Focusing the directory field, or typing in it, opens a list that hangs
  from it over the fields below. The field opens prefilled with the last
  directory, so until something is typed the list shows the most recent
  directories, up to `RECENT_DIRECTORIES`, not a filter by the prefilled
  path.
- Typed text splits on spaces, and every word must appear somewhere in the
  full path — written out or from `~`, case-insensitive. So `orb`,
  `slothworks/orb` and `sloth orb` all find `~/Projects/slothworks/orbital`.
  The canvas matched a plain query against the last folder only; the owner
  asked for the whole path. A word found in the name is filled there, one
  found only in the rest of the path is filled in the path. Most recent
  first.
- Each row: the directory's name, its path, how long ago a session ran
  there; on the phone also 9d's tag dot.
- Focusing the field selects its text, so typing replaces the prefilled
  path instead of appending to it.
- No match: the list closes and says nothing; the typed path stays and is
  checked at launch, as before.
- Desktop (1a–1c): ↑/↓ move the highlight, hover moves it too; nothing is
  highlighted until ↓, so Enter never swaps out a typed path. Enter or a
  click fills the field with the full path and closes the list. Esc closes
  the list; with the list closed, Esc closes the dialog as before. The
  RECENT chips stay. Focusing the field closes 50g's folder chooser. On
  another device the list is that device's directories. The list is
  portalled out of the dialog body, so a short window does not cut it
  off; with no room below it opens above.
- Phone (1d): the field opens on the device's last directory with no list
  under it. That prefilled path follows the device: a change of device
  replaces it with the new device's last directory; a path typed or picked
  stays. Tapping in (or clearing it) opens the list over the form; a tap
  on a row fills the full path and closes the list and the keyboard. The
  inline list, *Show all*, the *Use … as is* row and the no-match row of 9d
  are gone.

## How

- `web/src/lib/directorySearch.ts` holds the search for both and
  `web/src/lib/useDirectorySuggestions.ts` the field's state; the phone's
  `filterDirectories` is gone. `homePath` moved to `web/src/lib/format.ts`.
- Desktop: `web/src/panels/DirectoryField.tsx`. Phone: the DIRECTORY block
  of `web/src/mobile/screens/NewSessionScreen.tsx`.
- No server change: `GET /api/projects` and its limit stay.

## Scope

- **Who:** anyone who starts sessions in more than a handful of projects.
- **Where:** on by default. On the desktop it adds to the field and
  removes nothing. On the phone it replaces 9d's always-visible list: the
  list shows only while the field has focus, with ten rows until
  something is typed, and *Show all*, the ✓ on the chosen row, the *Use …
  as is* row and the no-match row are gone. The tag-colour dot on each
  row stays, though 1d leaves it out, so projects still read by colour.
  This follows 1d on purpose: the list no longer pushes the form below it
  down, and the phone and the desktop find a directory the same way.
- **What someone updating notices:** a list opens under the directory
  field when they click into it; typing filters it. On the phone the field
  opens on the last directory, and the list under it shows only while
  the field has focus.
- **Settings:** none.

## Phone

Built for the phone too (canvas 1d), on the same search. It uses only
`GET /api/projects`, which every Mac the phone can talk to already
answers, so nothing is gated in `MAC_FEATURES`.

## Versions

Desktop (`web/`) and the phone app over the air (`web/src/mobile`): a minor
bump each, a new feature. No native change.
