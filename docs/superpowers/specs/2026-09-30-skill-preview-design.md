---
id: 2026-09-30-skill-preview-design
title: A highlighted skill in the composer explains itself on hover and opens on click
type: spec
status: done
domain: web
related:
  - 2026-09-20-composer-design
  - 2026-09-29-composer-rich-editor-design
  - composer-highlighting-and-completion
tags:
  - composer
---

# A highlighted skill in the composer explains itself on hover and opens on click

The composer tints `/name` when it matches the command catalog, but the tint
says only "this exists". What the skill does is one hover away in a terminal
popup and nowhere at all once the popup is closed. This spec adds two things
to the tinted token: a tooltip with the description, and a read-only viewer
with the whole file behind a click.

## Scope

- Both composer fields: the detail panel's composer and the New Session
  dialog's first prompt. Both have a catalog behind them.
- Not the transcript. A sent turn's tint is display-only and has no catalog
  behind it (see `sentTokens.ts`); resolving an old `/deploy` against today's
  install would show a file that may not be the one that ran.

## Behaviour

- **Hover** over a tinted command shows a bubble above the token after the
  usual tooltip delay: the name in mono, then the source (`user`, `project`,
  `plugin: x`, `built-in`) and the catalog's description. No description
  means name and source only.
- **Click** on the token opens the skill viewer. A plain click is accepted
  even though it takes caret placement inside the token: the slug can still
  be edited with the arrow keys or by deleting it.
- A command with no file behind it — the CLI's built-ins, `/rewind` — gets
  the tooltip and nothing on click.
- **The viewer** is the file viewer's kind of surface (portal, escape layer,
  presence), not a form dialog. Header: name, source, the file's path. Body:
  the markdown rendered, frontmatter stripped. `Esc` or the close button
  dismisses it. It is not mirrored into the URL — unlike a file, a skill is
  not something one links to.

## Server

`GET /api/commands/content?name=<name>&session=<id>` (or `&cwd=<dir>` for the
New Session dialog) answers `{ name, source, path, description, body }`.

The file is found by running the same scan the catalog runs, which now
records each command's `path`. The route serves only a file the catalog
itself would offer, so `name` cannot be turned into a path read: an unknown
name, or one with no file, is `404`. `body` is the file minus its leading
`---` block.

## Design

There is no artboard for this. The bubble reuses the look of `ui/Tooltip`,
the viewer the look of `FileViewer`; a Claude Design pass can replace either
later.

## Tests

The route — each source resolves, an unknown or path-shaped name is `404` —
and the frontmatter strip. Not the UI.
