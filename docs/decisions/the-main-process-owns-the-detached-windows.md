---
id: the-main-process-owns-the-detached-windows
title: The Electron main process owns the list of detached session windows
type: adr
status: in-force
domain: desktop
related:
  - 2026-09-23-detached-session-windows-design
tags:
  - multitasking
---
# The Electron main process owns the list of detached session windows

## The problem

A detached session window changes what the main window does. Selecting that
session has to focus its window instead of opening the docked panel. Something
has to know which sessions are detached, and something has to be able to bring
a given window to the front.

## What was decided

The main process keeps a `sessionId → BrowserWindow` map and is the only
thing that knows it. The renderer asks main through the preload bridge
(`detachSession`, `focusSession`), and main pushes the list of detached ids to
the main window whenever it changes and whenever that window finishes loading.

## What was ruled out

**Windows coordinating among themselves** over `BroadcastChannel`, with main
only allowing `window.open`. It needs less IPC, but:

- a window that crashes never announces that it is gone, so the list goes
  stale;
- two detaches of the same session at once can race into two windows;
- a renderer cannot focus another window, so focusing would still need IPC
  to main, and the state would end up split between two places.

Main sees every window open, close and crash as it happens, and it is the
only thing that can focus a window anyway.
