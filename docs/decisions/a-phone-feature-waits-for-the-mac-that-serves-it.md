---
id: a-phone-feature-waits-for-the-mac-that-serves-it
title: A phone feature waits for the Mac that serves it
type: adr
status: in-force
domain: remote
related:
  - 2026-10-07-version-compatibility-design
  - 2026-10-09-session-media-design
tags:
  - mobile
  - versions
---

# A phone feature waits for the Mac that serves it

## The problem

The phone updates itself over the air, and the Mac updates when its owner
lets it. A phone away from its Mac can therefore run ahead of it for days.
`MIN_SERVER_VERSION` (spec [[2026-10-07-version-compatibility-design]]) is
the floor the whole app needs: below it the phone shows 9i and does nothing
else. That is right for what every screen depends on and far too much for
one new feature. Raising it for session media would lock the whole phone
behind "update your Mac", at exactly the moment its owner cannot.

Leaving it alone is not free either. An older Mac answers an unknown route
with 403, which degrades cleanly, but it drops a tunnel message it cannot
parse without a word. A phone that asks `file_get` with `as: 'pdf'` waits out
the timeout and then shows the file as missing.

## The decision

`web/src/mobile/version.ts` keeps a table, `MAC_FEATURES`: each feature the
phone uses above the floor, and the first Mac release that serves it.
`macSupports(feature, macVersion)` answers from the version the Mac sent in
its `hello`, which the phone keeps in its state (`macVersion`). A Mac that
has not said hello yet supports nothing; a Mac run from source (`dev`)
supports everything.

A feature gated this way is left out against an older Mac: not shown, not
asked for. The phone never sends a request it knows will go unanswered.
Session media is the first entry. Against an older Mac, PDF thumbnails are
left out and the PDF viewer fails at once to "can't show here". The Media
row is absent, because the media route answers 403.

Raising `MIN_SERVER_VERSION` stays the tool for a dependency the whole app
cannot work without.

## What was ruled out

- **The Mac announcing its capabilities in `hello`.** Cleaner in the long
  run, but it changes the protocol on both sides. Every Mac already out
  announces none, so for them it answers exactly what the version table
  does.
- **Raising `MIN_SERVER_VERSION` for each feature.** It blocks the whole app
  for one screen.
- **Asking and handling the failure.** It works for a 403, but not for a
  message an older Mac drops, which costs a timeout and a wrong state.
