---
id: 2026-09-30-narrate-out-of-band-design
title: Narrate out of band — a separate reader writes the walkthrough's narration
status: draft
type: spec
domain: walkthrough
related:
  - 2026-09-23-walkthrough-design
  - narration-is-written-by-a-separate-reader
  - walkthrough-narration-is-a-turn-in-the-session
  - narrate-can-lock-a-session-out
  - walkthrough-sits-behind-an-experimental-switch
  - ephemeral-title-queries
tags:
  - walkthrough
  - narration
  - settings
---
# Narrate out of band — a separate reader writes the walkthrough's narration

Replaces § Narration and § Asking of [[2026-09-23-walkthrough-design]]. The
rest of that spec — the spine, steps, attribution, the page — stands.

## Why

Narrate was a user turn sent into the session, asking the model to recount
what it had weighed and rejected. On 2026-09-29 the API's safeguards refused
that turn (`[reasoning_extraction]`), and because the refused turn stayed in
the session's history, every later turn was refused too
([[narrate-can-lock-a-session-out]]). Rewind now gets a session out of that
state, but a feature whose normal use can lock a session is not usable, and
it depended on one model's behaviour.

The decision to move the narration out of the session is
[[narration-is-written-by-a-separate-reader]].

## Scope

- Narrate runs as a one-shot query outside the session and never touches it.
- Its input is the session's visible record only.
- The narration is stored in SQLite, not read back from the transcript.
- Settings › Experimental gains a model picker for Narrate and a switch that
  asks Orbital's sessions to comment on their work aloud.
- Asking from a step is removed.

Out of scope: narrating automatically (on session end or on open), and
making the walkthrough visible by default — it stays behind
[[walkthrough-sits-behind-an-experimental-switch]] until the owner has tried
this.

## The query

`POST /api/sessions/:id/walkthrough/narrate` starts the query and answers
`202` at once. The query is a one-shot SDK call shaped like the titler's
([[ephemeral-title-queries]]):

- `persistSession: false` — no transcript, no planet, nothing to index;
- no tools (`allowedTools: []`), `maxTurns: 1`;
- the model from the `narrate_model` setting.

Because nothing is sent into the session, the route no longer refuses a
terminal session or one with a pending rewind, and a session that is running
can be narrated. It still answers `400 no_steps` on a walkthrough with
nothing to narrate, `404` on an unknown session, and `409 narrate_running`
while a query for the same session is in flight. At most one narrate query
runs per session.

## The input

A plain-text digest of what the transcript shows, built by a pure function
from the walkthrough and the session's parsed messages:

- the user's typed messages, in order;
- the assistant's visible text;
- each step: its id, ordinal, paths, and its calls with their inputs.

Thinking blocks are never included, in any form. Orbital's own injected
turns (command expansions, task notifications, old walkthrough tags) are left
out as the spine already leaves them out.

The digest is capped at `NARRATE_INPUT_MAX_CHARS`. When it is over, it is
shortened in this order until it fits: call inputs are truncated per call,
then the oldest assistant text is dropped, then the oldest user messages. A
step line (id, ordinal, paths) is never dropped — every step must be
nameable in the answer. A shortened digest says so in one line, so the model
knows the record is partial.

The prompt asks the model to describe only what the record shows. `considered`
lists alternatives only where the record states them — the user or the agent
said so — and `abandoned` is true only where the record shows the work being
undone or dropped. Otherwise they are empty and false.

The answer format is unchanged: exactly one fenced `json` block,
`{"intents":[{"title","summary","steps":[ids],"considered":[],"abandoned":false}]}`,
read by `parseNarration` as today.

## Storage and state

A new table holds one narration per session, replaced on each run:

| column | meaning |
|---|---|
| `session_id` | the session (primary key) |
| `status` | `running`, `done` or `failed` |
| `model` | the model that was asked |
| `intents` | the parsed intents, JSON; null unless `done` |
| `failure` | `refused`, `unparsable` or `error`; null unless `failed` |
| `started_at`, `finished_at` | timestamps |

A new run keeps the previous intents visible until it finishes: the row
moves to `running`, and the walkthrough reports the last `done` intents
alongside `narrationPending`. A `running` row left by a server that stopped
is `failed` / `error` on the next start.

The walkthrough's `narration`, `narrationFailed` and `narrationPending` keep
their meaning and their shape on the wire; they are computed from this row
instead of the transcript. `staleSteps` is still the number of current steps
no intent names. `narrationFailed` gains a `narrationFailure` reason beside
it, so the cover can say which of the three happened.

When the query finishes, the server broadcasts the change on the WebSocket,
so an open walkthrough page refetches.

Narrate turns already in old transcripts are no longer read as narration.
The tag parser stays so they still fold behind their chip in the transcript.

## Failure

- **`refused`** — the query ended in a refusal (stop reason or API error
  saying so).
- **`unparsable`** — it answered, but `parseNarration` returned null.
- **`error`** — anything else: the CLI failed to start, the call errored,
  the server stopped mid-run.

The cover shows the failure in one line with the button to try again. The
steps stay readable without a narration, exactly as before narrate was
pressed. There is no automatic retry and no fallback model; the user can
switch the model in Settings and try again.

## Settings › Experimental

Two rows below the walkthrough switch, both ordinary settings keys:

- **Narrate model** (`narrate_model`, default `sonnet`) — a picker over the
  models `ModelCatalog` lists.
- **Comment for Narrate** (`narrate_commentary`, default off) — when on, the
  runner appends a short instruction to the `claude_code` preset system
  prompt (`systemPrompt.append`) of every query it starts, spawn and revive
  alike: before a change, say in a sentence or two what is being changed
  and why, and name alternatives that were rejected. It asks for visible
  prose, nothing else. Terminal sessions are untouched — Orbital cannot reach
  their system prompt.

Placement and look follow the existing Experimental section. If the canvas
has no artboard for that section, the owner gets a Claude Design prompt
rather than a guessed layout.

## Removed

- Asking from a step: the `ask` route, `buildAskText`,
  `ASK_CONTEXT_MAX_CHARS`, the question field on the page, and the step's
  `questions` on the wire.
- `buildNarrateText` as a session turn. The prompt text moves into the
  narrate query.

## Testing

- The digest builder: no thinking in the output, the shortening order, step
  lines surviving any cap, Orbital's injected turns left out.
- The route: `202` and the row moving to `running`, `409` on a second call,
  `400 no_steps`, a terminal session accepted; the query mocked to answer,
  refuse, answer garbage and throw, each landing in the right state.
- Storage: the stale `running` row reset on start; previous intents kept
  while a new run is pending.
- The runner: `systemPrompt.append` present with the switch on, absent with
  it off.
