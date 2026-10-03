---
id: thinking-is-its-own-chatmessage-role
title: Thinking travels as its own ChatMessage role, not a flag or a side array
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - server
  - web
  - transcript
  - subagents
---

# Thinking travels as its own `ChatMessage` role, not a flag or a side array

## The problem

Before this branch, `ChatMessage.role` was `'user' | 'assistant' | 'tool_use'
| 'tool_result'` and `sdkToChatMessages`/`entriesToMessages`
(`server/src/runner/runner.ts`, `server/src/transcript/parser.ts`) dropped a
`thinking` content block on the floor entirely — Claude's reasoning never
reached the client at all. Turning it on needed a shape decision: attach it
to the neighbouring assistant message (a boolean flag, or a `thinking?:
string` field alongside `text`), collect it in a side array the renderer
consults separately, or give it a message of its own.

## What was decided

`ChatMessage.role` gains a fourth-turn value, `'thinking'` (`server/src/types.ts`,
mirrored in `web/src/lib/types.ts`), and both conversion paths — `sdkToChatMessages`
and `entriesToMessages` (`server/src/transcript/parser.ts:272-276`) — emit an
ordinary `ChatMessage` with that role and `text: block.thinking`, dropping
only signature-only empty blocks. It is not a field on the following
assistant message and not a parallel collection; it is one more entry in the
same message stream.

The reason is placement, not storage: canvas 11b interleaves a `THINKING`
block in reading order between prose and tool rows, and canvas 1b does the
same in the parent transcript (boxed there, a left hairline in the subagent
panel's compact variant; that treatment was later dropped, see below).
A flag or a side array both require the renderer to reassemble order from
two structures; a message with its own timestamp and its own position in
the array already has that order for free, the same way every other message
kind does.

## What was rejected

**A boolean/text field on the assistant message it accompanies.** Rejected
because the SDK does not always pair them that way — a thinking block can
arrive with no adjacent text block in the same turn — and because it would
have made every consumer of `ChatMessage.role === 'assistant'` also check a
second field for content that is not prose.

**A side array (`message.thinkingBlocks` or similar), rendered by the
transcript pipeline as an out-of-band pass.** Rejected because the pairing,
windowing and model-divider logic in `TranscriptView` already operates on
one flat, ordered array of `ChatMessage`; a second array would need its own
merge-by-timestamp step to interleave correctly, duplicating work the
existing array ordering does for nothing.

## Rendering: thinking reads as ordinary prose (revised 2026-10-03)

The role still travels on its own, but the transcript no longer draws it
differently. It first rendered as a `ThinkingBlock`: a boxed `THINKING`
fold, collapsed by default in the parent transcript and drawn as a hairline
in the subagent panel. That treatment assumed thinking was long raw
chain-of-thought, noise you would open only when you wanted it. What the CLI
emits today is short. Each block is a sentence or two saying what Claude
found and what it does next, and it is the most readable account of the work
between tool rows. A fold hid exactly that, and `▸ THINKING` on its own tells
you nothing. The owner asked for no distinction, so `TranscriptView` now
hands `thinking` to `MessageView` like assistant prose, and `ThinkingBlock`
and `TranscriptView`'s `compact` prop are gone. The `THINKING` box on
canvases 1b and 11b is now out of date.

Keeping the role separate still pays off. The model-divider logic reads
`model` off `thinking`
(`a-thinking-block-opens-a-turn-above-its-own-model-divider`), and a future
treatment can return without a server change.

## Consequences

- Every place that switches on `ChatMessage.role` (`MessageView`,
  `TranscriptView`'s pairing/grouping logic) gained one more case rather than
  one more optional field to check on an existing case.
- Thinking surviving conversion is pinned by `server/test/parser.test.ts` and
  `server/test/runner.test.ts`.
- `sdkToChatMessages` began stamping every emitted message — thinking
  included — with a `timestamp` in the same commit (2067c2c), because a
  thinking block needs one to sit correctly among tool-row durations that
  landed two commits later.
