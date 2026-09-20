---
id: 2026-09-20-interactive-decisions-design
title: Interactive decisions — AskUserQuestion as a clickable card
status: done
type: spec
domain: web
related:
  - 2026-09-20-composer-design
tags:
  - runner
  - detail-panel
---
# Interactive decisions — AskUserQuestion as a clickable card

Canvas: `Feature - Question Card.dc.html` (artboards 9a–9d; 9d carries
the metrics/colour/behaviour tables — the source of truth for every
value not repeated here).

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
  `allow + updatedInput.answers`. The card offers no dismiss (canvas:
  no close affordance; esc only collapses the Other… field) — `deny`
  happens only when interrupt or session end settles a still-pending
  decision.
- Any other tool: preserve today's behaviour — defer to
  `permissionMode`. The `kind` field is the extension point for
  permission prompts / dialogs later.

The answer travels over REST, not the hub:
`POST /api/sessions/:id/decision/:decisionId` with body `{answers}`.
REST because answering is request/response with a real outcome (404
when the decision no longer exists — already answered, interrupted, or
session ended), while the hub is a one-way broadcast. On settlement the
hub publishes `decision_resolved` so every client locks its card.

`answers` is `{[question text]: answer string}` per the SDK shape. A
clicked option sends its label; multiSelect joins the ticked labels
with `", "` and an empty selection sends `"none"` (canvas: zero
selections is allowed and stays sendable); free text sends the text
verbatim.

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
  no promise outlives its session. The card then locks to its
  read-only form with `UNANSWERED` in place of the status — nothing is
  auto-answered on the user's behalf.
- Two open windows: first answer wins; the loser's POST gets 404 and
  the `decision_resolved` broadcast has already locked its card.

## Web UI

The canvas (9a–9d) fixes the behaviour; 9d's tables carry the exact
values. The rules that shape the implementation:

- A new **QuestionCard** in the transcript (a sibling of
  `ToolRow`/`MessageView`). One tool call = one card; 1–4 questions
  stack inside it and are answered top-down — question n+1 becomes
  interactive only once n is answered (multi-question header shows
  progress ticks and `n / m`).
- Options are rows, never a dropdown: numbered gutter, label,
  description (clamped to 2 lines), plus an always-present free-text
  **Other…** row. **Single-select sends immediately on click** — no
  confirm step. `multiSelect` swaps the gutter for a checkbox and adds
  a confirm button; nothing sends until confirm, and zero selections
  is allowed.
- The **Other… row expands inline into the text field** (the card
  never grows a second composer); esc collapses it back; the cap is
  500 chars.
- Focus (hover, ⇥, ↑↓) reveals the focused option's `preview`, which
  renders **below the row block** — never between rows — max 6 lines,
  then it scrolls inside its own box. Keyboard: ↑↓/⇥ move focus,
  1–4 answer directly, ⏎ answers/confirms/sends, space ticks
  (multiSelect), esc collapses Other….
- **Composer while pending**: accent border, placeholder names the
  question's header chip ("Answer Approach, or pick an option
  above…"), hint line says ⏎ answers the question. If the question is
  answered by a click first, typed text stays in the box and reverts
  to a normal reply.
- Once answered, the card re-renders in its **answered form**: chip
  and question stay, accent border drops to the neutral hairline, the
  chosen option keeps the accent row (free text under a `YOUR ANSWER`
  eyebrow, exact text preserved), unchosen options collapse to one
  mono count line ("2 other options not taken").
- Historical `AskUserQuestion` tool_use/tool_result pairs from the
  transcript render the same answered form (the parser already pairs
  them). **Read-only cards** (watched terminal sessions, or a session
  that ended while pending) offer no hover, no cursor change, no
  focusable child — rows at the locked opacity, the terminal variant
  with the dashed "answer in the terminal" affordance.
- A pending card cannot be folded by the transcript-folding rules. On
  arrival it fades in and the panel scrolls to it only if the
  transcript was already pinned to the bottom. The main view is
  unchanged — a pending question is just the existing WAITING state.
- The accent throughout is the composer's panel-interaction accent
  `oklch(85% .12 205)`, never the session's tag hue.

## Testing

Boundaries, not rendering, per the project test policy:

- **Runner** — `canUseTool` produces a pending decision; answer
  resolves to `allow` with `answers`; interrupt/end settle pending
  decisions as `deny`; composer text while pending settles as the
  free-form answer and does not enqueue a user turn.
- **Routes** — the decision endpoint: happy path, 404 after
  settlement, 404 for unknown session, malformed body.
- **Parser** — pairing of `AskUserQuestion` tool_use/tool_result in
  historical transcripts.
- **Card state logic** (pure, extracted from the component) — top-down
  gating of stacked questions, multiSelect answer assembly (join,
  empty → "none"), keyboard focus transitions.

Not tested: QuestionCard pixels, labels, classNames.

## Out of scope

- Ordinary permission prompts (Allow / Always allow / Deny) — next
  `kind` on this channel.
- `onUserDialog` blocking dialogs (open `dialog_kind` union) — after
  that.
