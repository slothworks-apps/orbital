---
id: narrate-can-lock-a-session-out
title: A refused narrate turn locks the session out of every later turn
type: fix
status: active
domain: walkthrough
related:
  - walkthrough-sits-behind-an-experimental-switch
  - 2026-09-23-walkthrough-design
tags:
  - walkthrough
  - sessions
---
# A refused narrate turn locks the session out of every later turn

## What happens

On 2026-09-29, Narrate on a walkthrough's cover was answered with an API
error rather than a narration: the model's safeguards flagged the turn
(`Details: [reasoning_extraction]`, request
`req_011CfXmvEzxsijFRJXLHDyid`, Opus 5.5 with the 1M context).

The refused turn stays in the conversation, and every later turn resends
the conversation, so an ordinary follow-up message in the same session was
refused the same way. The session could not be continued from Orbital.

## Why it is not fixed here

The refusal comes from Anthropic's side, and why this turn was flagged is
not known; it has been reported as a false positive with the request id.

What Orbital can fix is being stuck afterwards. The CLI gets out with
`/rewind`; Orbital has no rewind yet (feature-parity audit, "Checkpoints
and `/rewind`"). Until it does, the walkthrough is off by default
([[walkthrough-sits-behind-an-experimental-switch]]).

## Getting a locked session back today

From a terminal in the session's project: `claude --resume <session-id>`,
then `/rewind` to the message before the narrate turn.

## Done when

Orbital can rewind a session to a message before a refused turn.
