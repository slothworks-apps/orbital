---
id: settings-sections-split-by-kind
title: Settings sections divide by kind of setting, not by the object it touches
status: in-force
type: adr
domain: web
related:
  - 2026-09-21-settings-sections-design
tags:
  - settings
---
# Settings sections divide by kind of setting, not by the object it touches

## The problem

The settings nav grew one section at a time, and its six labels ended up
speaking two different languages. *Sessions*, *Permissions* and *Tags &
rules* name an **object**: everything about that thing lives here.
*Appearance* and *Shortcuts* name a **kind**: everything of this sort lives
here, whatever it is about.

Both are defensible on their own. Together they leave a plausible home for
almost every row in two different places, and the dialog had already paid
for it: *Sessions* carried its own `MAP` kicker — model name under the
planet label, the context arc, the context thresholds — sitting three
inches from *Appearance*, which carried a `MAP` kicker of its own. Nothing
told a reader which one to open. `Claude Code executable`, an install path
the server reads once at boot, sat under `NEW SESSIONS` because that was
the only live section when it was added.

Every future toggle would have repeated the coin flip.

## The decision

Kind wins. One sentence per section, and the sentence decides:

- **General** — the application itself: where it looks, what it stores, how
  it starts.
- **Sessions** — what happens to a session: how it is born, what it
  inherits, when it is called ended.
- **Notifications** — what Orbital says out loud.
- **Permissions** — what a session is allowed to touch.
- **Tags & rules** — how sessions are labelled.
- **Appearance** — how it all looks.
- **Shortcuts** — how it is driven from the keyboard.

A row belongs to *Appearance* when changing it changes only what is drawn.
A row belongs to *Sessions* when changing it changes what happens to a
session. No row belongs to both, because no row does both.

## The borderline calls, and why

**Context thresholds go to Appearance**, though the numbers carry meaning —
they also colour sidebar rows and gate the `/compact` badge. They were
tempting to call behaviour. But they change no session's fate; they change
when a surface turns amber. Under the rule that is presentation, and the
alternative split the one feature across two sections so its on/off switch
and its numbers lived apart. They get their own `CONTEXT USAGE` kicker
rather than hiding under `MAP`, because the sidebar is not the map and a
`MAP` kicker would have been a lie.

**Lineage depth goes to Appearance** for the same reason. It governs how
many bodies of a chain stay drawn; the sidebar's history is unlimited
regardless, so nothing about the sessions themselves changes.

**Release ended sessions into history stays in Sessions.** It looks like
declutter, but per [[the-hole-subsumes-map-declutter]] the bond is cut and
the session's relationship to the map ends. That is a fate, not a
viewport.

**Notifications became its own section** rather than a third group under
*Sessions* or a group inside *General*. Its events are session events, so
*Sessions* was the near miss — but the section answers "what interrupts
me", which is the user's question, not the session's, and it has room to
grow (per-tag scoping, quiet hours) that a kicker does not.

## Consequences

- *Sessions* drops from thirteen rows to eight and contains nothing about
  pixels for the first time. Its second kicker is renamed `CLEAR &
  LIFECYCLE`, lineage having left.
- The nav grows to seven items. *Notifications* is inserted after
  *Sessions*; every other item keeps its canvas 1h position.
- Settings keys do not change. The moves are entirely a question of which
  column renders which `Row`, so no migration and no server change comes
  with them.
- Rows that arrive later have one question to answer instead of two, and
  the answer is the same for everybody who asks it.
