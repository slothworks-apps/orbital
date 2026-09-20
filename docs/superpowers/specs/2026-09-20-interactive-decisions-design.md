---
id: 2026-09-20-interactive-decisions-design
title: Interactive decisions — AskUserQuestion as a clickable card
status: active
type: spec
domain: web
related:
  - 2026-09-20-composer-design
tags:
  - runner
  - detail-panel
---
# Interactive decisions — AskUserQuestion as a clickable card

When the model calls the `AskUserQuestion` tool, Claude Code's own CLI
renders an interactive picker. Orbital today renders nothing of the
sort: the runner passes no `canUseTool` to `query()`, so the SDK
auto-denies the tool, the model falls back to asking in plain prose,
and the user types "A" into the composer. This spec wires the channel
the CLI uses and renders the question as a clickable card in the chat.

## What the SDK actually provides

Verified against the installed `@anthropic-ai/claude-agent-sdk`
(0.3.272, `sdk.d.ts` / `sdk-tools.d.ts`):

- The model's call arrives fully structured:
  `AskUserQuestionInput.questions` is 1–4 of
  `{question, header, options: [{label, description, preview?}] (2–4),
  multiSelect}`.
- The SDK delivers it to the host through the `canUseTool` callback in
  `query()` options. The host renders the question, collects the
  choice, and resolves with
  `{behavior: 'allow', updatedInput: {...input, answers: {[question]: label}}}`.
  `answers` is the documented field ("User answers collected by the
  permission component"); a dismissal is `{behavior: 'deny', message}`.
- Without `canUseTool`, "ask" decisions are terminal — the auto-deny
  that produces today's plain-text fallback.
- The same callback carries ordinary permission prompts (with `title`,
  `displayName`, `description`, `suggestions` ready-made), and a
  separate opt-in `onUserDialog` carries other blocking dialogs. Both
  are OUT OF SCOPE here, but the envelope below is shaped so they can
  ride it later as new `kind`s without changing the transport.
- Unanswered `canUseTool` promises have **no park deadline** — the tool
  stays blocked until the host answers. Every exit path must settle the
  promise.

## Channel (server)

`Runner.start()` passes a `canUseTool` callback into `query()`.

- `toolName === 'AskUserQuestion'`: build a **pending decision**
  `{id (the toolUseID), sessionId, kind: 'question', payload
  (AskUserQuestionInput), createdAt}`, store it on `ManagedSession`,
  publish it on the hub as a new `decision_pending` message, and return
  a Promise that resolves when the answer arrives. Resolve to
  `allow + updatedInput.answers`; a cancel resolves to `deny` (the
  model continues, the CLI-Esc equivalent).
- Any other tool: preserve today's behaviour — defer to
  `permissionMode`. The `kind` field is the extension point for
  permission prompts / dialogs later.

The answer travels over REST, not the hub:
`POST /api/sessions/:id/decision/:decisionId` with body `{answers}` or
`{cancelled: true}`. REST because answering is request/response with a
real outcome (404 when the decision no longer exists — already
answered, interrupted, or session ended), while the hub is a one-way
broadcast. On settlement the hub publishes `decision_resolved` so every
client locks its card.

## State and lifecycle

- A session with a pending question keeps status **`needs_input`** — no
  new status; the map and sidebar already signal "waiting on you". The
  pending decision joins the session snapshot a newly connected client
  receives, so a page reload does not lose the question.
- **Composer text answers the question.** While a decision is pending,
  `send()` first settles it with the typed text as the free-form
  ("Other") answer and sends nothing else — the text reaches the model
  as the answer to the question, which is what it meant.
- Interrupt and session end settle any pending decision as `deny`, so
  no promise outlives its session.
- Two open windows: first answer wins; the loser's POST gets 404 and
  the `decision_resolved` broadcast has already locked its card.

## Web UI

- A new **QuestionCard** in the transcript (a sibling of
  `ToolRow`/`MessageView`): the `header` chip, the question text, 2–4
  clickable options (label + description), `multiSelect` with a confirm
  button, always an extra free-text "Other…" field, and the option's
  `preview` content when the model sent one.
- Once answered, the card re-renders in its **answered form** —
  question plus the highlighted choice. Historical
  `AskUserQuestion` tool_use/tool_result pairs from the transcript
  render the same way (the parser already pairs them), so read-only
  terminal sessions show questions properly too — just without
  interactivity; the terminal answers there.
- The visual design comes from Claude Design: a prompt for the canvas
  is generated after this spec is approved, and implementation waits
  for the artboard.

## Testing

Boundaries, not rendering, per the project test policy:

- **Runner** — `canUseTool` produces a pending decision; answer
  resolves to `allow` with `answers`; cancel resolves to `deny`;
  interrupt/end settle pending decisions; composer text while pending
  settles as the free-form answer and does not enqueue a user turn.
- **Routes** — the decision endpoint: happy path, `{cancelled}`, 404
  after settlement, 404 for unknown session.
- **Parser** — pairing of `AskUserQuestion` tool_use/tool_result in
  historical transcripts.

Not tested: QuestionCard pixels, labels, classNames.

## Out of scope

- Ordinary permission prompts (Allow / Always allow / Deny) — next
  `kind` on this channel.
- `onUserDialog` blocking dialogs (open `dialog_kind` union) — after
  that.
