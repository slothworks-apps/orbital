---
id: browse-opens-the-native-folder-picker
title: The New session dialog's Browse… opens the native folder picker, desktop only
status: in-force
type: adr
domain: desktop
related:
  - the-new-session-dialog-remembers-the-last-launch
  - the-phone-tunnels-the-api-behind-an-allowlist
  - tilde-expands-at-the-api-boundary
tags:
  - sessions
---
# The New session dialog's Browse… opens the native folder picker, desktop only

## The problem

Canvas 1d draws a "Browse…" button beside the PROJECT DIRECTORY field. The
first version left it out, so the only ways to choose a directory were to
type or paste the path, or to click one of the four recent ones.

## The decision

Browse… calls `dialog.showOpenDialog` in the Electron main process
(`choose-directory` in `desktop/src/main.ts`). The picker opens as a sheet
on the window that asked, and only Orbital's own windows can ask. It starts
at the path already in the field. `pickerStartPath` in
`desktop/src/lib/chooseDirectory.ts` expands `~` there, and falls back to
the home directory for anything that is not an absolute path. The chosen
directory replaces the field's value. Cancelling leaves the field as it was.

The button exists only when the desktop bridge has `chooseDirectory`
(`canChooseDirectory` in `web/src/lib/desktop.ts`). A browser tab and the
phone do not show it.

## What is ruled out

- **A directory browser drawn by Orbital, served by the server.** It would
  work in a browser and on the phone too. But it needs a new endpoint that
  lists the Mac's directory tree, a decision on whether the phone allowlist
  may reach that endpoint, and an artboard in Claude Design. The phone
  already launches sessions with a typed path or a recent one. That is
  enough until somebody misses a picker there.
- **`<input type="file" webkitdirectory>`.** A browser never gives the page
  a directory's absolute path. It also uploads the directory's contents.
