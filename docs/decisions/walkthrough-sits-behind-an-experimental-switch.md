---
id: walkthrough-sits-behind-an-experimental-switch
title: The walkthrough sits behind a hidden Experimental switch
status: in-force
type: adr
domain: walkthrough
related:
  - 2026-09-23-walkthrough-design
  - narrate-can-lock-a-session-out
  - 2026-09-30-narrate-out-of-band-design
tags:
  - walkthrough
  - settings
---
# The walkthrough sits behind a hidden Experimental switch

## The problem

A narrate turn got refused by the API's safeguards, and the refusal did not
stay with that turn: every later message in the same session was refused
too, and Orbital has no way to rewind past it
([[narrate-can-lock-a-session-out]]). The DMG goes to people other than its
owner, and one click on Narrate could leave their session unusable.

## The decision

The walkthrough stays in the build, off by default, behind a switch in a
Settings section called Experimental. The section is not in the nav until
⌘⇧. is pressed while Settings is open; a second press hides it again. Both
states are ordinary settings rows (`experimental_unlocked`,
`walkthrough_enabled`), so the owner's choice survives restarts and works
in the DMG and in dev alike.

With the switch off, the detail panel neither shows the walkthrough control
nor asks the server for its summary, and `/walkthrough/<id>` sends the
browser to the map. The server's walkthrough routes are left alone: the
switch hides a feature from people who would stumble on it, it is not a
security boundary, and there is nothing to guard on a server that binds to
localhost.

## Alternatives ruled out

- **An environment variable.** No UI, but the DMG is started by launchd,
  and setting a variable there is a chore every time.
- **A visible Experimental section.** Simplest, but everyone would see it
  and some would switch it on.
- **Dev builds only.** The owner could no longer try it in the app they use
  every day.

## When to revisit

When Orbital can rewind a session past a refused turn, or narrate stops
being refused, the switch can default to on or go away.

Rewind shipped on 2026-09-29, and [[2026-09-30-narrate-out-of-band-design]]
takes narration out of the session. The switch stays until the owner has
tried the new narration; the Narrate model picker and the commentary switch
live in the same section meanwhile.
