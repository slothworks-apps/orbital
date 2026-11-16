---
id: new-session-remote-folder-chooser-clipped-by-the-options-scroll
title: New session's remote folder chooser is cut off by the options' own scroll
status: backlog
type: fix
domain: web
related:
  - 2026-11-09-harness-from-new-session-design
tags:
  - web
  - new-session
  - device-group
---
# New session's remote folder chooser is cut off by the options' own scroll

## What happens

In New session's step 1 the options columns scroll on their own, so
FIRST PROMPT keeps its room above the footer (canvas 65e). The folder
chooser for another device, opened by **Browse <device>…** under PROJECT
DIRECTORY, is not portalled: `FolderChooser` is an absolutely positioned
panel hung under the field (canvas 50g), meant to lie over the groups
below it. Inside the options' scroll it can no longer reach past the
scroll's bottom edge.

In a short window (around 1024 × 720) the options get only a few hundred
pixels, and the lower part of the chooser, its **Choose this folder** row
included, sits below that edge.

## Why it is not fixed yet

It still works: the chooser scrolls itself into view as it opens
(`scrollIntoView` with `block: 'nearest'`), which now moves the options'
scroll instead of the dialog body. What changes is that the options shift
up when it opens, where before the chooser lay over them. Not yet seen in
the app with a second device; fix it once that shift turns out to bother.

## How to fix it

Portal the chooser and anchor it to the field, the way `DirectoryField`
places its suggestion list (`usePopupPosition`), so no ancestor's overflow
clips it.
