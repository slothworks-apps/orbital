---
id: 2026-09-30-assisted-harness-templates-design
title: Assisted harness templates — a model drafts the checklist from a description, a session or a conversation
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-session-harness-design
  - a-harness-continues-from-its-checklist-not-a-judge
tags:
  - harness
  - experimental
---
# Assisted harness templates

Builds on [[2026-09-30-session-harness-design]]. Writing a good template by
hand is the slow part: the steps, which of them are gates, what "done" means
for each. Three ways to have a model draft it, over one shared core.

## The drafter (server)

`server/src/harness/drafter.ts`. A one-shot model call, through the same
path as the titler and the watcher, on Sonnet: a template is used for a long
time, so its quality is worth more than the call.

- Input: a free-text description, a digest of an example session, or both.
  The names of the existing templates ride along, so it does not duplicate
  one by accident.
- Output: a template as JSON. It is parsed (a fenced block or the first
  object in the reply) and checked with the same `validateTemplate` the
  editor saves through. An invalid reply is sent back once with the error.
  A second failure is an error for the user, not a half template.
- The prompt says what a good template is: gates only where the user wants
  to decide; concrete done criteria; a verify command only when the reply is
  sure of it; inputs (`{{key}}`) for anything that changes per run, never a
  literal URL or ticket id; the user's language.

**Session digest.** The live branch, condensed: every user message whole,
the assistant's prose trimmed, tool calls as one line each, capped at
40 000 characters from the start (the shape of the work is in its first
half; the tail is mostly the same steps repeating). The user's
interventions are what mark gates, so they are kept first when the cap
bites.

`POST /api/harness/templates/draft` `{ description?, sessionId? }` → 200
`{ template }` (not saved) | 400 when both are empty | 404 for an unknown
session | 422 `{ error }` when the model's draft stays invalid | 502 when
the call fails.

## Path 1 + 2: "Draft with assistant" in the editor

A panel above the editor, opened by "✦ Draft with the assistant" under the
template list: a text field for the description and an optional session
picker (the 30 most recent sessions). Draft fills the editor with a new,
unsaved template. Nothing is saved until the user presses Create.

## Path 3: "Draft in a conversation"

The button starts a new session in the directory of the last launch, with a
fixed first prompt: interview the user one question at a time about how the
work goes, propose the checklist, and once they agree, save it.

Saving goes through a third tool on the `orbital` MCP server,
`harness_save_template`, auto-approved like the other two. It validates and
answers with the error when the template is not valid, so the agent fixes
it. It is available in every session while the feature is on — a user can
equally ask any session to "make a template out of what we just did".

`GET /api/harness/interview` → `{ prompt }` keeps the prompt next to the
tool it describes; the web launches the session with it.

## Testing

- Reply parsing: fenced JSON, bare JSON, prose around it, invalid JSON, a
  template that fails validation.
- The retry: one bad reply then a good one; two bad replies.
- The digest: user messages kept whole, the cap.
- The route: validation, unknown session, the model's failure.
- `harness_save_template` is glue over the tested `createTemplate`; it was
  checked live instead (2026-09-30): an empty `steps` came back refused with
  the reason, and the agent's corrected call saved.

## Found while trying it

Three drafts against the real model changed the prompt: a gate step opened
the PR itself (a gate is approved after its work, so no step's work is
outward); approval came out as a separate "get sign-off" step (a gate is the
step whose result is signed off); and a Czech description came back in
English (the language rule is now the prompt's last line, not only in the
system prompt).
