---
id: hand-a-session-to-another-mac
title: Hand a session and its working tree to another Mac
status: backlog
type: idea
domain: remote
related:
  - 2026-10-06-peer-macs-design
tags:
  - remote
  - sessions
---
# Hand a session and its working tree to another Mac

With peer Macs ([[2026-10-06-peer-macs-design]]) a session can run on
the Mac that stays on, which removes most of the need. What is left:
moving an idle session, with its uncommitted code, from one Mac to the
other and continuing there.

## The feasible shape

1. Only an idle session can be handed over; a running turn cannot move.
2. **Code.** Snapshot everything tracked and untracked-but-not-ignored
   as a commit on a temporary ref (`refs/orbital/handoff/<id>`), push it
   to the repo's origin, fetch and check it out on the target. If the
   repo is missing on the target, clone it first.
3. **Session.** Copy the transcript
   (`~/.claude/projects/<encoded cwd>/<id>.jsonl`) through the tunnel and
   resume it through the SDK; carry Orbital's own rows (tags, pin, title).
4. End the session on the source.

## What makes it hard

- A different path on the target (another user name, another checkout
  location) leaves stale absolute paths in the transcript the agent reads.
- The transcript is the CLI's undocumented format.
- Not transferable: ignored files (`.env`, `node_modules`), running dev
  servers and background tasks.
