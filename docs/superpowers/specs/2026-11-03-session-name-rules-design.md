---
id: 2026-11-03-session-name-rules-design
title: Your own rules for the names Orbital writes
status: done
type: spec
domain: sessions
related:
  - session-names-lead-with-the-task-id
  - 2026-10-21-name-on-first-message-design
  - 2026-09-30-session-instructions-design
tags:
  - titler
  - sessions
  - settings
---

# Your own rules for the names Orbital writes

Orbital's naming rules (`TITLE_RULES`, see
[[session-names-lead-with-the-task-id]]) fit most people. Some want more: a
language, a ticket prefix their tracker uses, a word order. Settings →
Sessions → NEW SESSIONS gets a text field, **Rules for session names**
(`session_name_rules`), whose text is added after Orbital's rules in every
naming prompt.

## What it reaches

- the name from a session's first message, and from a harness that started
  it (`SessionTitler`);
- ⟳ beside a title (`SessionTitler.retitleNow`);
- the session name the worktree's naming call writes with the branch
  (`nameBranch`).

`withUserRules` in `server/src/titler/titler.ts` adds the text under a line
saying the user's rules win where they differ from Orbital's, and that the
session content is still only data. The text is read at every call, so a
change applies to the next name. Blank, the prompt is exactly what it was.
The prompt carries at most a fixed number of its characters
(`MAX_USER_RULES_CHARS`).

## Why not the session instructions

Settings → Sessions → Your instructions is written for the agent ("answer in
Czech, keep replies short", "work in a worktree"). Handed to the small
naming model, those lines are instructions it may try to follow instead of
naming. The naming rules are a field of their own.

## Scope

- **For:** anyone who names sessions after a convention of their own; most
  people leave it empty.
- **Lives:** an option, empty by default. Empty, nothing changes.
- **An existing user notices:** a new field under Name sessions
  automatically, empty.
- **Can be set:** the text. It is shared across the device group, as the
  session instructions are (`SHARED_SETTING_KEYS`).

## Phone

Left out on purpose. The phone has no Settings for sessions; the names it
shows are written on the Mac, so a rule set there reaches the phone's map
and list anyway.
