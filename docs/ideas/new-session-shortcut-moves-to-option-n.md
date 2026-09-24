---
id: new-session-shortcut-moves-to-option-n
title: Move the new-session shortcut off ⌘N, which the browser keeps for itself
status: superseded
type: idea
domain: web
related:
  - desktop-wrapper-electron
  - 2026-09-23-shortcuts-design
tags:
  - space-map
  - shortcuts
---
# Move the new-session shortcut off ⌘N, which the browser keeps for itself

`SpaceMap` registers ⌘N / Ctrl+N for the new-session dialog and the floating
button prints a `⌘N` keycap next to its label. In a browser tab on macOS the
handler never runs: Chrome and Safari reserve ⌘N for a new window at the
application level, the page is not consulted, and `preventDefault` has nothing
to prevent. The shortcut is advertised and dead.

⌥N reaches the page. It should be the binding, and the keycap in `SpaceMap`
should say so.

## The trap in the implementation

The existing handler tests `e.key.toLowerCase() !== 'n'`. That is right for
⌘N and wrong for ⌥N: on a US layout Option+N is the dead key for a combining
tilde, so `e.key` arrives as `˜`, not `n` — and it changes again on other
layouts. The physical key is what is meant here, so the test becomes
`e.code === 'KeyN'`.

Everything else the handler already does stays: the `isTypingTarget` bail
matters more than before, since ⌥N inside a text field is a character someone
may genuinely be typing.

## What about the desktop shell

⌘N becomes available again inside the Electron wrapper
([[desktop-wrapper-electron]]), where the main process owns the menu and its
accelerators. That is an argument for accepting both there, not for keeping two
different shortcuts for the same action in two builds of the same product —
the keycap can only print one, and it should print the one that works
everywhere.

Worth a look at the same time: ⌘K (`Sidebar`, focus search) does reach the
page, so it is fine as it stands.
