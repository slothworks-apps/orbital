---
id: 2026-11-02-text-context-menu-design
title: Context menu on selected text and in text fields
type: spec
status: active
domain: web
related:
  - 2026-10-24-session-context-menu-design
  - 2026-10-26-media-viewer-context-menu-design
tags:
  - transcript
  - ui
---

# Context menu on selected text and in text fields

In the desktop app a right-click on selected text does nothing, and neither
does one in the composer or any other field: Electron draws no menu of its
own, and Orbital draws one only on a planet, a session row and the image in
the media viewer. Copying a piece of the transcript or pasting into the
composer works only through the keyboard.

After this change a right-click opens Orbital's `ContextMenu` at the pointer:

| where | rows |
|---|---|
| inside a text selection in a selectable surface (`[data-selectable]`: the transcript, the viewers, error detail, commands) | Copy |
| in an editable field (`input`, `textarea`, the composer, any `contenteditable`) | Cut · Copy · Paste · Select All |

Drawn in `Feature - Path menu glyphs.dc.html` 1h. Each row carries its
shortcut in the row's `detail` (`⌘X`, `⌘C`, `⌘V`, `⌘A`); these are the
system's own edit shortcuts, so they hold whether the menu is open or not.
In a field, Cut and Copy stay in the list, disabled, when nothing is
selected, so the rows never jump as the selection changes; Paste is always
enabled (reading the clipboard to decide would need a permission for
nothing). Copy takes `CopyGlyph`; Cut, Paste and Select All take the new
`CutGlyph`, `PasteGlyph` and `SelectAllGlyph` (1h). Every field uses the
same four rows: the composer, rename, settings, search.

A right-click anywhere else, including selectable text outside the
selection, still opens nothing.

## How it works

- **One listener.** A `contextmenu` listener on the document decides,
  after the owners' own handlers ran: an event an owner already handled
  (`defaultPrevented`: a planet, a session row, the media viewer, the path
  menu once it exists) is left alone; otherwise an editable target gets the
  field menu, and a pointer inside the current selection's rectangles gets
  Copy.
- **The actions are the app's own edit commands.** A new desktop bridge
  call, `edit(action)` with `cut`, `copy`, `paste` or `selectAll`; main takes
  it only from an Orbital window and runs `webContents.cut()` and so on. They
  do exactly what the keyboard shortcuts do, so the composer's editor sees a
  real paste (its undo, its paste handling, an image on the clipboard as an
  attachment) and a copy from the transcript carries the same text and
  formatting as ⌘C. Focus and selection are back in the field before the
  command runs.
- **In a browser tab** (the dev server, an Orbital opened without the
  desktop app) the listener does nothing, so the browser's own menu stays,
  which already does all of this.

A path link inside the selection (once paths have their own menu, spec
2026-11-02-bare-file-names-and-path-menu-design): the path menu takes over,
and its Copy path stands in for this Copy (1h).

## Scope

- **Who it is for:** anyone who copies from the transcript or pastes into
  the composer with the mouse.
- **Where it lives:** on by default. A right-click on text or a field did
  nothing; nothing that worked before changes.
- **What someone already using Orbital notices:** a right-click on selected
  text or in a field opens a menu.
- **What can be set:** nothing.

## The phone

Left out on purpose: the phone's WebView already offers the system's own
selection callout (copy, paste, select all) on a long-press, and a second
menu would fight it. No idea to write; there is nothing missing there.

## What was ruled out

- **The native macOS menu** (`webContents.on('context-menu')` with roles).
  It needs less code and comes with the system's extras, but it would look
  unlike every other menu in Orbital; the maintainer chose Orbital's own.
- **`navigator.clipboard` for the actions.** Paste would need the
  clipboard-read permission and would bypass the editor's own paste
  handling; Copy would lose the formatting ⌘C keeps.
