---
id: 2026-09-23-end-session-design
title: End session — a plain way to close a session from the detail panel
type: spec
status: done
domain: sessions
related:
  - what-a-session-waits-for-is-a-label
  - fold-the-header-strip-when-the-branch-joins
  - the-header-strip-folds-on-the-path-width
tags:
  - web
  - server
  - detail-panel
---

# End session — a plain way to close a session from the detail panel

Agreed with Tomin on 2026-09-23. The behaviour here is settled and is not
for the canvas to change.

**Design:** Claude Design, `Feature - Header actions.dc.html`, artboards
**23a** (the header strip, the End session tooltip and the End session
dialog) and **23b** (the Clear, End session and Collapse glyphs, their
tooltips and states). 23c/23d, the adaptive fold behind `⋯`, came later:
see [[the-header-strip-folds-on-the-path-width]].

**Built** on 2026-09-23. Where it differs from the text below, the canvas
won on copy: the End tooltip reads "Stops the agent and moves the session
to history.", the dialog body "`<title>` stops and moves to history — the
transcript stays readable there.", and Clear's tooltip became the one-line
"Clear and start over". With "Clear only" gone, the Clear dialog's body
drops "or just clear and decide later", and the "Don't ask again" path
now clears and starts new too (it used to clear only), so nothing in the
web app sends `startNew: false`.

The adaptive fold (23c form 5, motion 23d) is built too, later the same
day: when the path and branch run out of room the strip folds to pin · end
· ⋯ ‖ collapse, with stats, clear and detach in the ⋯ menu
([[the-header-strip-folds-on-the-path-width]]). The subagent panel's ×
became the same collapse chevron.

## The problem

The detail panel has no action that simply ends a session. What exists:

- **Clear** opens the `/clear` dialog. Its secondary button, "Clear only",
  ends the session without starting a new one — which *is* "close the
  session", but nobody looks for it there: the dialog talks about `/clear`,
  lineage and "start over", and the button's glyph is a left arrow that
  reads as "back".
- **×** in the header closes the *panel* (deselects). It says nothing about
  the session, and as the only × in sight it invites the wrong guess.

## The behaviour

### End session

- A new header action, **End session**, on Orbital sessions (`source:
  'web'`) whose status is not `ended`. Terminal sessions do not get it —
  Orbital does not own their process ([[orbital-first-terminal-features-limited]]).
- It confirms first, in a short dialog of its own: *"`<title>` ends and
  moves to history."* Two buttons, Cancel and End session. No lineage
  preview, no "start new" option, no "don't ask again" — ending is rarer
  than clearing and the confirmation is the point.
- On confirm the server ends the session: `runner.end(id)`, the same call
  `/clear` makes. The session becomes `ended`, the planet takes the ended
  treatment, the row moves to HISTORY, the panel stays open on the ended
  session (as it does after "Clear only" today).
- Server: a dedicated route, `POST /api/sessions/:id/end`, a thin wrapper
  around `runner.end` with the same 404 for an unknown id. Reusing
  `/clear` with `startNew: false` would work, but the route's name would
  then lie about what the header button does. `/clear` keeps `startNew` for
  compatibility; nothing in the web app sends `false` any more.
- Available in a detached window too (canvas 22c): the action is about the
  session, not the panel.
- Tooltip on the icon, like Clear's: title "End session", description "Ends
  the session and moves it to history."

### Clear

- The `/clear` dialog loses "Clear only". It keeps Cancel and
  "Clear & start new"; the footer caption drops the `⇧⏎ clear only` hint.
  The "Don't ask again" checkbox stays — it belongs to clearing.
- The Clear icon changes: the current left arrow reads as "back". Which
  glyph is for Claude Design.

### Close panel

- The × becomes a collapse chevron in the spirit of the sidebar's `»`/`«`
  toggles, so the header says "slide the panel away" rather than "close
  something". Behaviour unchanged: it deselects. Detached windows still
  have no such button (the window's own close is the whole of "dock back").

## What Claude Design decides

Everything visual, on an artboard of its own: the header strip with the
new action and the new Clear glyph, the collapse chevron in place of ×,
the End session dialog. Constraints for the prompt:

- Header row per artboard 9d: pin, Clear, then Detach and the panel toggle
  as a tighter pair (canvas 22a). End session sits with the session trio,
  not with the panel pair.
- Every icon needs a tooltip (variant as Clear's); icon-only is fine.
- The dialog uses the existing `Dialog` shell (eyebrow, title, body,
  footer with Cancel + primary) and the 1g copy voice.
- The chevron should read as a sibling of the sidebar's collapse toggle.

## Tests

- Server: the new route ends the session and 404s an unknown id.
- Web: no render tests; the store action that calls the route is glue.
