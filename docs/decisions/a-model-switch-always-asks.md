---
id: a-model-switch-always-asks
title: Switching a session's model always asks first
status: in-force
type: adr
domain: sessions
tags:
  - detail-panel
  - models
---
# Switching a session's model always asks first

## The problem

Picking another model in the detail header's switcher applied at once. It
looks free — the conversation is kept — but it is not: a prompt cache belongs
to one model, so the next turn on the new model reads the whole context again
at the full input rate instead of mostly from the cache. At 150k tokens of
context that is a noticeably more expensive turn, on the subscription a bigger
bite out of the usage limit.

The terminal warns about this. Claude Code 2.1.280 computes, for a switch,
`prompt_cache_warm` ("whether the current model's prompt cache is likely still
warm (a switch then forfeits it)"), the cache TTL and an
`estimated_cache_write_usd`, and warns only while the cache is warm.

## What was decided

Every switch asks, whatever the cache is doing (`SwitchDialog` in
`web/src/panels/ModelSwitcher.tsx`). The dialog names the model and the
session's measured context (`contextUsedTokens`), and says the next message
reads it all again. Cancel changes nothing; Switch (or ⏎) applies it as
before.

## What was ruled out

- **Asking only while the cache is warm, as the CLI does.** It is the more
  precise rule, but a dialog that appears on one switch and not on the next
  reads as random (owner, 2026-09-28). Orbital would also have to guess the
  warmth from the last turn's time and the TTL, which it does not know.
- **No confirmation.** The cost is real and invisible at the moment of the
  click.
