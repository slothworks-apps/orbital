---
id: a-subagents-question-is-refused-not-relayed
title: A subagent's question is refused, not relayed to the human
type: adr
status: in-force
domain: subagents
related:
  - subagent-question-ignores-agent-id
  - 2026-09-22-subagent-transcript-panel-design
  - the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with
tags:
  - server
  - runner
  - subagents
---

# A subagent's question is refused, not relayed to the human

## The problem

`Runner.decide()` is the SDK's `canUseTool`. It used to treat every
`AskUserQuestion` the same, whoever asked it. A question from inside a
subagent was parked on the parent session under the subagent's own
`toolUseId`, and it replaced whatever decision the parent was already
waiting on
([[subagent-question-ignores-agent-id]]). The only surface that shows that
question is the subagent panel, and that panel is read-only by design. So
the card could not be answered where it was shown, and the parent's
composer could answer a question it never displayed.

The SDK gives `decide()` what it needs to tell the two apart: `opts.agentID`
is set when the call comes from inside a subagent.

## What was considered

- **Relay it.** Give the question its own kind of `PendingDecision`, tagged
  with the agent, and let the subagent panel answer it. This means making
  the panel interactive, holding more than one parked decision per session
  (the parent can be waiting on its own at the same time), and designing a
  card that says whose question it is. Nothing observed on this machine has
  ever asked one.
- **Route it to the parent's card.** The parent's composer already answers
  a parked question. But the parent's transcript never shows the subagent's
  tool call, so the card would ask something out of context. It would also
  still replace a question the parent was waiting on.
- **Refuse it.** Deny the call with a message telling the model to ask from
  the parent session instead. The subagent carries on or reports back, and
  the parent can ask the human itself.

## What was decided

Refuse it. When `opts.agentID` is set and the tool is `AskUserQuestion`,
`decide()` returns a `deny` with that message at once. It parks nothing,
publishes nothing and settles nothing, so a question the parent was already
waiting on stays parked.

Only questions are refused. A subagent's permission ask keeps its old path:
it parks on the parent session, and the parent's permission card answers it.
That card makes sense without the subagent's transcript, because it names
the tool and its input.

## Consequences

- A subagent that asks the human something gets a refusal and has to go on
  without an answer. The parent sees the subagent's report and can ask the
  question itself.
- The subagent panel's `readOnly` guard stays. Permission asks from a
  subagent still park under the subagent's `toolUseId`, so the panel still
  must not become interactive because an id happens to match.
- If subagents start asking questions in practice, relaying them is the
  option to reopen. It needs a design for the panel first.
