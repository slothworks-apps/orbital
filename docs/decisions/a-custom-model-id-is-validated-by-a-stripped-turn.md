---
id: a-custom-model-id-is-validated-by-a-stripped-turn
title: A custom model id is validated by a stripped probe turn, not by a list
status: in-force
type: adr
domain: sessions
related:
  - models-come-from-the-sdk
  - 2026-09-16-agent-model-design
tags:
  - models
---
# A custom model id is validated by a stripped probe turn, not by a list

## The problem

`Query.supportedModels()` lists the current generation only: on 2026-09-23
that is Opus 5.5, Fable 5.1, Sonnet 5 and Haiku 4.5. A user who wants Opus 5
or Opus 4.6 — still served, just no longer the newest — has nowhere to say
so. The server has always passed `options.model` to the SDK as an opaque
string, so the only thing missing was a way to type one in, and a way to
know before launch that the id is real. A typo is otherwise discovered by a
dead planet whose first turn failed.

## What was decided

**The picker gets an `Other` card with a text field for a full model id**,
in the New session dialog and in Settings. No design canvas: it is a small
change and it uses the cards' own vocabulary. A dropdown of older models was
considered and set aside: its list would have to be hard-coded, which is
what [[models-come-from-the-sdk]] rules out, and it would still need a free
text fallback for anything not on it.

**The id is validated by running one real, stripped-down turn on it.**
`POST /api/models/validate` spawns a query with `maxTurns: 1`, no tools, no
MCP servers, no settings sources and a one-sentence system prompt in place of
the Claude Code preset, and sends the word `ok`. Measured on 2026-09-23:

| id | outcome | input tokens | cost |
|---|---|---|---|
| `claude-opus-nope` | `result.is_error`, `api_error_status: 404` | 0 | $0 |
| `claude-opus-4-6` | `result` with `modelUsage['claude-opus-4-6']` | ~330 | ~$0.002 |
| `claude-opus-5`, same call with the Claude Code preset kept | valid | ~67 000 | ~$0.68 |

The last row is why the turn is stripped: with the normal system prompt, tool
schemas and MCP servers attached, a validation would cost as much as a short
session. Stripped, it is cheap enough to run on blur, and it comes with a
bonus: a successful probe reports the model's `contextWindow` in
`modelUsage`, so `recordContextWindows` learns the window for the custom
model before the session that uses it ever starts.

A successful validation is remembered in memory for the process lifetime and
concurrent validations of one id share a probe, so reopening the dialog does
not bill again. The launch itself remains the final check: a model that
vanishes between validation and launch fails the first turn with Claude
Code's own message.

Two things the SDK does that the implementation has to know:

- After an error `result`, the query generator **throws** when the CLI
  exits (`Claude Code returned an error result: …`). The validation reads
  the `result` message, stops iterating, and treats a throw after a captured
  result as already handled.
- The invalid case is answered by the API's 404 before any inference, so it
  is free and fast (under two seconds).

## Rejected

- **A hard-coded list of previous generations.** Drifts, and contradicts
  [[models-come-from-the-sdk]].
- **`GET /v1/models` on the Claude API.** Orbital runs on the subscription:
  `ANTHROPIC_API_KEY` is deleted from its environment at startup, and the
  CLI's OAuth credentials are not Orbital's to borrow.
- **No validation, let the launch fail.** Free, but the failure lands after
  the planet exists, and Settings would happily store a typo as the default
  for every future session.
- **A deliberately malformed request that fails after model resolution but
  before billing.** Depends on the API's undocumented validation order and
  would make a bad id and a bad parameter indistinguishable.

## What follows from it

Any id Claude Code accepts can be launched, defaulted and remembered per
project. A model outside the catalog shows its raw id where a catalog model
shows its version, and its context bar appears as soon as the probe or the
first turn has taught the window. Mid-session switching to a custom id is
not built; the switcher still lists the catalog only.
