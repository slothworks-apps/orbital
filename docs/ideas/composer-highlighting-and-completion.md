---
id: composer-highlighting-and-completion
title: The composer should highlight and complete skills, commands and file mentions
status: backlog
type: idea
domain: web
related:
  - clickable-file-paths-in-the-transcript
tags:
  - detail-panel
  - shortcuts
---
# The composer should highlight and complete skills, commands and file mentions

Typing `/code-review` or `@web/src/App.tsx` into Orbital's composer gets no
highlight, no suggestion and no confirmation that the thing being named
exists. The same text in a terminal is coloured as it is typed and completed
from a list. Here it is grey prose until the CLI either recognises it or does
not, and a typo is only discovered a turn later.

Two fields are involved: `DetailPanel`'s bare `<textarea>` inside the composer
well, and `NewSessionDialog`'s `FIRST PROMPT` field, which has exactly the same
problem for the first prompt of a session.

## Nothing on the server knows what a skill is

`server/src` has no notion of skills or commands anywhere — the word does not
appear. Completion needs a source of truth, which means a new read-only route
that collects:

- `~/.claude/skills` and `~/.claude/commands` (`CONFIG.claudeDir` already
  points there, and the watcher already lives in that directory)
- the project's own `.claude/skills` and `.claude/commands`, which depend on
  the session's `cwd` — the session row already carries it
- plugin skills, whose names are `plugin:skill`

Which means the list is per-session, not global, and a session in another
project gets a different one. Files for `@` mentions are the same shape of
problem pointed at `cwd`, and share the confinement rules that
[[clickable-file-paths-in-the-transcript]] has to settle anyway.

The risk to name up front: a completion the CLI will not honour is worse than
no completion. The route should collect what the CLI itself would load, and
when in doubt offer less.

## Highlighting means a mirrored layer

A `<textarea>` cannot style its own contents, so the standard construction is
an `aria-hidden` div behind a textarea with a transparent caret colour, both
sharing font, size, line-height, padding and wrapping exactly, with the div
rendering the same text as spans. It is fiddly but well-trodden; the fiddly
part is keeping the two in metric lockstep, and the composer's field is
already a bare textarea with no borrowed styling to fight.

A contenteditable would avoid the mirror and cost far more: `Enter` to send /
`Shift+Enter` for newline, paste handling, and IME composition all stop being
free. Not worth it for this.

## The popup already exists

`ui/Select` implements a keyboard-driven popup — typeahead, Arrow/Home/End,
Escape through the escape layer — and its behaviour is what a completion list
needs. Reuse that rather than writing a second listbox, and register the popup
in the escape layer so `Esc` dismisses the suggestions before it deselects the
session.

## Where to start

Highlighting without completion is already most of the value and carries none
of the "what exists" problem: a `/name` at the start of the composer and an
`@path` anywhere can be tinted from the text alone. Ship that first, then let
the popup arrive behind the route.
