---
id: session-names-lead-with-the-task-id
title: A session's name leads with its task ID and may run past the map label
status: in-force
type: adr
domain: sessions
related:
  - sessions-are-named-once-from-their-first-message
  - session-titles-only-on-demand
  - 2026-09-18-auto-title-design
tags:
  - titler
  - sessions
---

# A session's name leads with its task ID and may run past the map label

The titler's rules (`TITLE_RULES` in `server/src/titler/titler.ts`, and the
session line of `BRANCH_SYSTEM_PROMPT` in `server/src/worktree/naming.ts`)
now ask for two things the auto-title spec did not:

- When the session names a task or ticket ID (a ClickUp `CU-…`, a Jira-style
  `ABC-123`, a GitHub `#183`), the name starts with it.
- A longer, descriptive name is preferred over a short vague one: the word
  range widened and `MAX_TITLE_CHARS` grew past what the map's label shows
  uncut.

## Why

The ID is how the work is found again, in the tracker, the branch and the
PR. A name without it has to be matched by its wording.

The old limit was set by the width of the map's label, and it pushed the
model toward three-word names that said nothing ("Fix bug in panel"). The
map's label cuts a long name with an ellipsis and types the rest out on
hover, so a name longer than the label loses nothing there; the sidebar
and the session header have the room.

## Ruled out

- **The ID at the end of the name.** The label's cut would drop it first.
- **Keeping the limit and fitting the ID inside it.** An ID takes around
  ten characters, and what was left was too short to describe the work.
