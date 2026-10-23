---
id: sessions-are-named-once-from-their-first-message
title: A session Orbital starts is named once, from its first message
status: in-force
type: adr
domain: sessions
related:
  - session-titles-only-on-demand
  - 2026-10-21-name-on-first-message-design
tags:
  - titler
  - sessions
---

# A session Orbital starts is named once, from its first message

Narrows [[session-titles-only-on-demand]]: a session still never renames
itself as it moves on, but one Orbital starts is named once, right after its
first message, unless the `name_sessions_automatically` setting is off.

## Why

The automatic rename that was removed failed for reasons a one-time name
does not share. It had to decide *whether* to rename, and its guards almost
never agreed; this has nothing to decide — the derived title is a cut
sentence, never a name. And its risk was a name moving while someone looks
at it; this one changes once, a moment after the session appears, before
anyone has learned to find it by the old label.

## On by default, though it costs a call

The removed design kept automatic titling off by default because it spends
money in the background ([[2026-09-18-auto-title-design]] → The setting).
This one is on, at the maintainer's request, and the cost is weighed rather
than ignored:

- it is one Haiku call per session Orbital starts — on a subscription a sliver
  of the usage limit, under `ORBITAL_USE_API_KEY=1` a fraction of a cent —
  against a session that is itself a model run many times that size;
- it never runs again for that session, and never for a session Orbital did
  not start, so the cost cannot grow with how long a session lives or how
  many terminal sessions are on the map;
- what it buys is the map's labels, which every user reads; a cut sentence is
  the default experience it replaces, not an edge case;
- the setting says it asks a model, and turning it off restores the old
  label exactly.

## Ruled out

- **Naming after the first answer.** The model would see more than the
  prompt and name more precisely, but the label would stay a sentence for
  the whole first turn, which can take minutes. The prompt alone says what
  the session is for.
- **Terminal sessions too.** Orbital pays a model only for what it launched;
  ⟳ covers a terminal session on request.
- **Reusing `auto_title_sessions`.** Stored databases still hold that row
  with whatever the removed feature left in it.
