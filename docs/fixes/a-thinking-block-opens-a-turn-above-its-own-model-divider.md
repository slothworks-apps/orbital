---
id: a-thinking-block-opens-a-turn-above-its-own-model-divider
title: A turn that opens with thinking renders its reasoning above its own model divider
status: backlog
type: fix
domain: transcript
related:
  - 2026-09-22-subagent-transcript-panel-design
  - thinking-is-its-own-chatmessage-role
tags:
  - web
  - transcript
---

# A turn that opens with thinking renders its reasoning above its own model divider

Found by the whole-branch review of `feat/subagent-panel`. Filed rather than
fixed: it is a placement question about an already-shipped divider (canvas
4a), the misplacement is one row and never loses content, and the branch's
own spec does not scope `insertModelDividers`.

## What the bug is

`insertModelDividers` (`web/src/panels/TranscriptView.tsx`) decides where a
model changed by reading the model off assistant messages only:

```ts
const message = group.kind === 'message' ? group.item.message : undefined
const model = message?.role === 'assistant' ? message.model : undefined
```

`thinking` is its own `ChatMessage` role
([[thinking-is-its-own-chatmessage-role]]) and it carries a `model` too —
`sdkToChatMessages` sets it from the same frame, in the same branch that
sets it on text. The divider does not look at it.

An extended-thinking turn frequently opens with a `thinking` block before
its first `text` block. When such a turn is also the first turn after a
model switch, the divider is inserted at the first ASSISTANT message, which
is the prose — so the reasoning that the NEW model produced renders above a
divider announcing the switch to it, visually attributed to the old model.

## Why it is not fixed here

Two things are unclear and neither is this branch's call:

- **Which role should be allowed to move the divider.** Reading `model` off
  `thinking` as well is a two-word change, but the divider's own doc
  describes it as sitting between "consecutive assistant messages", and
  whether a reasoning block counts as one of those is a design question
  about canvas 4a rather than a bug in the loop.
- **Whether the divider belongs above the thinking block at all.** A reader
  might reasonably expect it at the TURN boundary rather than at the first
  message carrying a model, which would be a different (and larger) change:
  the function has no notion of turns.

## Where to start

`insertModelDividers` and its tests in `web/src/test/transcriptview.test.tsx`.
The narrow version is widening the role check to include `'thinking'`; the
honest version is deciding what a divider is anchored to first.
