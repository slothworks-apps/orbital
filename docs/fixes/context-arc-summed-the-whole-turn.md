---
id: context-arc-summed-the-whole-turn
title: The context arc summed a whole turn's API calls and read 1513.6k into a 1M window
status: done
type: fix
domain: sessions
related:
  - context-fill-arc
  - context-usage-has-one-source
  - revived-session-shows-no-context-gauge
tags:
  - context
  - usage
  - sdk
---
# The context arc summed a whole turn's API calls and read 1513.6k into a 1M window

## What happened

Session `056a9b26` sat at `1513.6k / 1M ctx`, `OVER WINDOW`, on a model whose
window the CLI would have refused to exceed. The stored row agreed:
`context_used_tokens = 1513619`.

Its real context at that moment was **222 559 tokens**.

## Why

`Runner.pump()` read the arc's numerator off the SDK's `result` message:

```ts
const used = contextUsedFromUsage(msg.usage);
```

`result.usage` is not a snapshot of the window. The SDK types say so
outright:

> **MAIN AGENT LOOP ONLY** — excludes Task subagent, sidechain, and auxiliary
> model calls, and **is per-turn** in streaming-input sessions.

Per-turn means summed across *every API request the turn made*. A turn with
tool round-trips makes one request per round-trip, and each of those requests
re-reads the entire conversation from the prompt cache — so
`cache_read_input_tokens` is counted again in every one of them. The measured
number grows with how many tools the turn used, not with how full the window
is.

That session's final turn, verbatim:

| API call | prompt + output |
|---|---|
| 1 | 211 047 |
| 2 | 211 398 |
| 3 | 211 777 |
| 4 | 213 816 |
| 5 | 220 972 |
| 6 | 222 050 |
| 7 | **222 559** |
| **`result.usage`** | **1 513 619** |

Seven calls, each of them roughly the same ~220k conversation, added up. The
last row is the window; the total is a billing figure.

**It was not subagent context**, which was the first suspicion — that session
ran none at all (zero sidechain entries in its transcript), and `result.usage`
excludes them by definition.

## What it is now

Two sources, best first, in `Runner.contextUsed()`:

1. **`query.getContextUsage({ detail: 'summary' })`** — the CLI counts what it
   will actually send next (system prompt, tool schemas, memory files,
   messages) and answers with `totalTokens`. This is a measurement of the
   window rather than an inference from a bill, and it is the same number
   `/context` prints. `detail: 'summary'` because the per-category breakdown
   costs token-count API calls and only the total is wanted.

   Note the shape: the method resolves to a flat, camelCase
   `SDKControlGetContextUsageResponse` (`totalTokens`, `maxTokens`,
   `rawMaxTokens`). The snake_case `context_usage.total_tokens` in the SDK
   types is a *different* message — the structured twin attached to a
   `/context` slash-command result. Reading for the wrong one costs nothing
   visible, because the fallback quietly answers every turn instead.
2. **The turn's last main-loop API call** — tracked as each `assistant`
   message streams past, and used when the control request cannot be answered
   (an older CLI) or does not answer in `CONTEXT_USAGE_TIMEOUT_MS`. One
   request behind the truth, but always available.

`contextUsedFromUsage` became `contextUsedFromAssistantUsage`. The arithmetic
did not change — the four fields are still the right four — only what it is
allowed to be handed. The name is the guard: the old one invited exactly the
call site that caused this.

Three details that are load-bearing:

- **The latest call wins; calls are never added.** A streaming response
  arrives as several `assistant` messages sharing one `message.id`, each with
  a later `usage` for the same request. Keeping only the most recent reading
  handles both that and the tool round-trips with one rule.
- **`parent_tool_use_id` non-null is skipped.** A subagent fills a window of
  its own. It was not the cause here, but it would have been in any session
  that dispatches one.
- **The reading is consumed at the end of each turn, and cleared at a
  `compact_boundary`.** A turn that measures nothing stays silent rather than
  re-reporting the previous turn's figure, and calls made before a compaction
  cannot outlive the conversation they measured.

## The stored rows

Every value written before this fix is a turn total, and the real figure
cannot be recovered from the row. Migration `0008_stale_context_readings`
clears them all: a live session rewrites its own when its next turn ends, and
an ended one shows no gauge — which is honest, where the old number was
confidently wrong.

## What was not verified

The fallback is proven end to end against session `056a9b26`'s real numbers.
The `get_context_usage` path is proven against the SDK's declared response
shape only — confirming it on a live CLI means spawning a session, which
Tomin has ruled out. If that call ever fails or changes shape, nothing breaks:
every turn falls through to the last-call reading, which is the number this
fix was written to produce.

## Still open

The denominator was not touched. `contextWindowFor` draws against the model's
nominal window (1M for a `[1m]` variant), while `get_context_usage` reports
`rawMaxTokens` — the *resolved autocompact window*, which on a 1M-window
model is often the 200k compaction boundary instead. If those disagree, the
arc is measuring against the wrong denominator even now that its numerator is
right. `rawMaxTokens` is already in the response this fix reads; wiring it
through is a separate change against
[[context-usage-has-one-source]], which is where the denominator's single
source is decided.
