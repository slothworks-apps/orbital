---
id: helper-queries-run-under-the-sessions-account
title: Helper queries about a session run under that session's Claude directory
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - ephemeral-title-queries
  - narration-is-written-by-a-separate-reader
tags:
  - accounts
  - titler
---
# Helper queries run under the session's account

## The problem

Besides the sessions themselves, Orbital makes its own SDK calls: the
titler, the narrator, harness ask and the harness reviewer. Each sends a
session's content to a model. With more than one Claude directory, the
call has to run under some login.

## The decision

A helper query about a session runs under that session's directory, with
the same `CLAUDE_CONFIG_DIR` rule the session itself is launched with.
The limits probe and the model catalog are not about a session, and they
run once per directory.

The reason is where the content goes, not the cost. A work session's
transcript, sent through the personal account to be summarised, leaves
the employer's enterprise account. Its data-handling terms may not allow
that.

## What is ruled out

- **All helper queries under the default directory.** It is simpler, but
  it moves work content to the personal account.
- **A setting for the helper account.** No choice here is safe except the
  session's own. A setting would only offer the unsafe one.
