---
id: pick-the-claude-directory-with-the-most-headroom
title: A new session picks the Claude directory with the most headroom, or its tag's
status: active
type: idea
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - 2026-10-03-usage-limits-design
  - 2026-09-18-tag-clusters-design
  - 2026-10-13-tag-defaults-design
tags:
  - accounts
  - limits
---
# Pick the directory with the most headroom

Two subscriptions on one person are there to spread the load, but the New
session dialog picks the directory from the selected planet or the last
launch, so spreading it is by hand.

The server resolves the directory in `launchSession` when the request
names none, first match wins:

1. **The tag's directory.** `tags` gets a nullable `claude_dir_id` (spec
   2026-10-13-tag-defaults-design). The tag is the one the session will
   wear (the request's, else the cwd's rule match, else the default tag).
   That is how a project gets its account. **Done:** part 1 is implemented
   and ships with tag defaults.
2. **The most headroom.** Among directories with no window at 100 % and no
   open limit wait, the one whose most-used window is lowest; ties go to
   the first in order. It uses cached limits and never waits for a probe;
   opening the dialog refreshes data older than five minutes. **Backlog:**
   part 2 is future work, to be taken up when the time is right.

The phone and `spawn_session` children follow the same rule, so a
long piece of work spreads across accounts without a picker.
