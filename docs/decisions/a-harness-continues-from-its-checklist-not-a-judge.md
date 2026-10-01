---
id: a-harness-continues-from-its-checklist-not-a-judge
title: A harness continues from its checklist, not from a judge of the last message
type: adr
status: in-force
domain: sessions
related:
  - 2026-09-30-session-harness-design
tags:
  - harness
---
# A harness continues from its checklist, not from a judge of the last message

## Context

Agents on a feature branch often stop at "shall I continue?" when the work
goes on. The first idea was a classifier that reads the agent's last message
and decides whether Orbital may send it on — the laya model
(`convaiinnovations/laya`, a ModernBERT decision model) was the candidate.

A spike on 63 real turn ends from `~/.claude/projects` (2026-09-30), labelled
by what the user actually answered, measured it. Always answering STOP scored
0.698. Laya multilingual and typed-decisions `noul` scored 0.32–0.70 and was
uncalibrated (≈0.9 on almost everything); its `choice` head and a tuned Haiku
prompt tied the majority class at 0.698.

## Decision

- Whether to continue comes from the session's **checklist**: a tick followed
  by a non-gate step is an advance, deterministically. A gate waits for the
  user.
- A model is asked only when a turn ends **without** a tick, and it is given
  the checklist and the active step's done criteria — the context the
  spike's judges lacked. It runs through the titler's one-shot path (Haiku).
- Laya is not used. Every watcher verdict is logged in `harness_events`
  with the agent's text, so a fine-tune can be tried once there is data.

## Consequences

- The harness needs a template to do anything; a session without one keeps
  today's behaviour.
- The watcher's quality is unmeasured in production until the events pile up.
