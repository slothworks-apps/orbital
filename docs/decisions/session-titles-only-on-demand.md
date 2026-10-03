---
id: session-titles-only-on-demand
title: A session is renamed from its contents only when someone asks
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-18-auto-title-design
  - ephemeral-title-queries
tags:
  - titler
  - sessions
---

# A session is renamed from its contents only when someone asks

The automatic half of [[2026-09-18-auto-title-design]] is gone: the
`auto_title_sessions` setting, `SessionTitler.feed` / `considerTurnEnd`, the
vocabulary gate `shouldRetitle` and the cooldown. What stays is the ⟳ beside
the title in the detail panel — `POST /api/sessions/:id/retitle` →
`SessionTitler.retitleNow`.

## Why

It did not do its job. On the maintainer's own database, with the setting on,
11 of 605 sessions carried a model-made name on 2026-10-03, and that count
includes every click on ⟳. A session that moved on almost never got renamed,
because every guard had to agree before the model was even asked:

- it only ever saw Orbital's own sessions — the feed is the Runner's stream,
  so terminal sessions were never considered;
- its buffer lived in memory, so a server restart (every desktop app launch)
  started each session's count from zero;
- it needed three new user messages, then none of the five most frequent new
  words could appear in the current title — a loose match that a session
  still in the same repository usually hits;
- a ten-minute cooldown after every ask;
- and the prompt tells the model to prefer KEEP.

Tuning the gate looser trades this for the failure the spec warned about: a
name that moves while you are looking at it. The button already covers the
case that matters — you notice a name is wrong and fix it with one click —
and it works for every session, terminal ones included.

## What changes for a stored database

The `auto_title_sessions` row stays in the `settings` table of existing
databases; nothing reads it. `title_source = 'auto'` is still written, by the
button, and still means "the model named this, not a person".
