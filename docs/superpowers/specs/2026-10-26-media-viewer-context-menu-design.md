---
id: 2026-10-26-media-viewer-context-menu-design
title: Context menu on the image in the media viewer
type: spec
status: active
domain: web
related:
  - 2026-10-24-session-context-menu-design
  - 2026-10-09-session-media-design
tags:
  - media
  - ui
---

# Context menu on the image in the media viewer

A right-click on the image in the maximised media viewer opens a menu at the
pointer: Copy image, Copy path, Show in Finder. Without it there is no way to
get a picture out of a conversation: the desktop app has no native context
menu, so a right-click on the image does nothing at all.

## What the menu holds

| row | shown when | does |
|---|---|---|
| Copy image | the item is an image (not a PDF) | puts the image on the clipboard as PNG |
| Copy path | the item has a path (the agent named it, or a tool wrote it) | puts the file's absolute path on the clipboard |
| Show in Finder | the item has a path, the session runs on this Mac, and the page runs in the desktop app | reveals the file in Finder |

A pasted screenshot or a tool's image lives in Orbital's image store; it has no
path a person would want, so it gets Copy image alone. A file that is no
longer on disk draws no image, and so has no menu.

The menu is the same `ContextMenu` the session menu uses (spec
2026-10-24-session-context-menu-design): the same rows, keys and dismissal.
Its rows say what they do in words; no icons.

## How it works

- **Copy image.** The renderer fetches the bytes it already shows and writes
  them with `navigator.clipboard.write`. Chromium takes only `image/png` there,
  so any other format is drawn into a canvas and re-encoded as PNG first. A copy
  that fails is recorded and said, as Copy path in the session menu is (adr
  errors-are-recorded-not-announced).
- **The absolute path.** A path in a reply is resolved by the server against
  several trees (the cwd it was written in, its git root, the session's working
  tree, home), so the client cannot rebuild it. `GET /api/files/locate` answers
  the path `/api/files/image` would read, through the same `fileSandboxes` and
  `resolveForSession`, without reading the file. Copy path falls back to the
  path as written when the server cannot locate it.
- **Show in Finder.** A new desktop bridge call, `showInFolder(path)`; main
  takes it only from an Orbital window and only for an absolute path, and hands
  it to `shell.showItemInFolder`, which reveals and never opens.

## Scope

- **Who it is for:** anyone who wants an image out of a conversation, into
  another app, a chat or a bug report.
- **Where it lives:** on by default. It adds a menu where a right-click did
  nothing; nothing that worked before changes.
- **What someone already using Orbital notices:** a right-click on the image in
  the viewer opens a menu.
- **What can be set:** nothing.

Transcript thumbnails and gallery tiles keep their right-click as it is; the
menu lives on the viewer, where the image is looked at.

## The phone

Left out on purpose. The phone has no right-click, and its own viewer
(`web/src/mobile/files/ImageViewer.tsx`) is a touch surface where a share sheet
would be the answer, not this menu. `/api/files/locate` stays off the remote
allowlist: the phone has nothing to reveal a Mac's path in.
