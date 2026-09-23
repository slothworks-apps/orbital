---
id: 2026-09-23-permission-and-plan-decisions-design
title: Permission prompts and plan approval — the other two decision kinds
status: done
type: spec
domain: sessions
related:
  - 2026-09-20-interactive-decisions-design
  - permission-prompts-write-no-permission-rules
  - an-approved-plan-continues-in-acceptedits
  - typed-text-declines-a-permission-ask
tags:
  - runner
  - detail-panel
  - agent-sdk
---
# Permission prompts and plan approval — the other two decision kinds

Picks up where `2026-09-20-interactive-decisions-design` left off. That
spec built one channel — park a `canUseTool` call, publish it, answer it
over REST, settle it exactly once — and used it for exactly one tool,
`AskUserQuestion`. Every other tool was answered with a synthetic
`deny`: *"Orbital has no prompt surface for X."*

Two things followed from that.

- **There was no permission prompt at all.** A session had to be
  launched in `acceptEdits` or `bypassPermissions` and hoped for; any
  tool the CLI would have asked about died mid-turn.
- **Plan mode was a dead end.** `ExitPlanMode` is a tool, so it hit the
  same deny. The New Session dialog offered plan mode and nothing could
  ever leave it.

This spec adds the two remaining kinds on the SAME envelope. No new
transport, no new events, no second settle path.

## What the SDK actually provides

Verified against the installed `@anthropic-ai/claude-agent-sdk`
(0.3.278, `sdk.d.ts` / `sdk-tools.d.ts`):

- `canUseTool`'s third argument carries ready-made prompt copy for an
  ordinary ask: `title` (the bridge's full sentence, "Claude wants to
  read foo.txt"), `displayName` (a short noun phrase), `description` (a
  subtitle), plus `blockedPath`, `decisionReason`, `mcpServer` and
  `matchedAskRule`. Two flags matter for safety: `defaultToNo` ("open on
  the decline option, offer no one-key approve") and
  `suppressAlwaysAllowRule` ("offer no don't-ask-again choice here").
- `PermissionResult` is `{behavior: 'allow', updatedInput?,
  updatedPermissions?, decisionClassification?}` or `{behavior: 'deny',
  message, interrupt?, decisionClassification?}`. **`updatedInput` is
  optional**, which is what makes a plain approval possible: the
  question path rewrites the tool's input (merging `answers`), a
  permission approval must not touch it at all.
- "Always allow" is `options.suggestions: PermissionUpdate[]` echoed
  back as `updatedPermissions`. Each `PermissionUpdate` names a
  `destination` — `userSettings`, `projectSettings`, `localSettings`,
  `session` or `cliArg`. **Deliberately not exposed here**; see adr
  `permission-prompts-write-no-permission-rules`.
- `ExitPlanMode`'s declared input holds only a deprecated field plus an
  index signature, but the CLI sends `{plan: "<markdown>"}` — confirmed
  against real transcripts in `~/.claude/projects`.
- `Query.setPermissionMode(mode)` is a control request available in
  streaming-input mode. It is the only thing that actually takes a
  session out of plan mode; allowing `ExitPlanMode` alone leaves the
  CLI read-only.

## Channel (server)

`decisionKindFor(toolName)` is total and decides the surface:

| tool | kind |
|---|---|
| `AskUserQuestion` | `question` |
| `ExitPlanMode` | `plan` |
| anything else | `permission` |

Total on purpose — a tool this build has never heard of gets a surface
rather than a synthetic denial, which is the whole point.

`PendingDecision` keeps its shape and grows optional fields:
`toolName`, and the bridge's `title` / `displayName` / `description` /
`defaultToNo`. Each is carried ONLY when the CLI sent it, so an older
CLI produces exactly the envelope it did before. The prompt copy is the
bridge's, never reconstructed here: two hosts wording the same ask
differently is how they come to disagree about what a tool is about to
do.

Everything else is reused verbatim — `settleDecision`, the
`decision_pending` / `decision_resolved` hub events, `pendingDecision`
on the session snapshot, the `needs_input` status, the no-idle-timer
rule, the settle-on-interrupt/end/abort paths, and the defensive
supersede of an older park.

### Permission modes

`bypassPermissions` means "do not ask me". The CLI normally honours
that before the callback is reached, but a rule or a safety check can
still route one here — and a session launched to run unattended must
not stop on a card nobody is watching for. So in `bypassPermissions` a
`permission` ask is allowed without parking.

`question` and `plan` are NOT permission prompts and are unaffected by
the mode: the model asked the human something, and no mode answers that
on their behalf. (In practice a `bypassPermissions` session is not in
plan mode either, so `plan` never arrives there.)

### Answering

`answerDecision(sessionId, decisionId, answer)` widens its third
parameter to `DecisionAnswer`:

```ts
type DecisionAnswer = Record<string, string> | { approved: boolean; message?: string }
```

**Which arm applies is decided by the PARKED decision's `kind`, never by
sniffing the payload.** A question's answers map is
`Record<string, string>` and could hold any key at all, so the shape
alone can never be the discriminator. A payload that does not fit the
parked kind is refused — `false`, which the route reports as a 400.

That check is load-bearing rather than pedantic. Reading a permission
prompt as a question would settle it `{behavior: 'allow', updatedInput:
{...input, answers}}` — both corrupting the command and approving it.

- `question` → unchanged: `allow` with `answers` merged into the input.
- `permission` / `plan`, approved → `{behavior: 'allow'}`. **No
  `updatedInput`**: approving a tool must not rewrite what it was asked
  to do.
- `permission` / `plan`, declined → `{behavior: 'deny', message}`, the
  message being the user's own reason or a plain fallback. A refused
  tool does not end the turn; the model reads the refusal as this tool's
  result and picks another route, so the session goes back to `working`.

`decisionClassification` is set (`user_temporary` / `user_reject`) —
telemetry only, but the SDK asks hosts that genuinely prompt a human to
say so rather than let the CLI infer it.

### Leaving plan mode

Approving a `plan` decision is the one approval that is not only about
the tool in front of it. Before settling, the Runner fires
`generator.setPermissionMode(APPROVED_PLAN_MODE)`.

**Before, deliberately.** Both the control request and the permission
answer travel the CLI's stdin, and stdin is ordered, so firing it first
is what puts the new mode in place before the tools the approved plan
calls for. It is not awaited: the browser's POST is answered by the park
being over, not by the CLI acknowledging a mode, and `answerDecision`
stays synchronous so the question path and its tests are untouched.

Only a session actually in `plan` moves; a model calling the tool from
some other mode is asking for nothing, and rewriting an `auto` session's
mode on the back of it would be a downgrade nobody asked for. A CLI too
old to answer the request leaves the session read-only — degraded, never
less safe than what was chosen at launch.

The new mode is reported through a new `onPermissionMode` Runner hook,
which `index.ts` writes to the sessions row and republishes, so the
panel's readout stops claiming the session is read-only and an autoheal
after a restart resumes it in the mode it was actually running in.

Which mode: `acceptEdits`, always — see adr
`an-approved-plan-continues-in-acceptedits`.

### The REST route

One endpoint for all three kinds, unchanged:
`POST /api/sessions/:id/decision/:decisionId`.

The lookup now comes FIRST, because which body is valid depends on the
kind the server is parked on. A session with nothing parked is still the
same 404 it always was.

- `question` takes `{answers}` — complete or nothing, one entry per
  question, keyed by the question's own text.
- `permission` and `plan` take `{approved, message?}`.

Validating against the SERVER's kind rather than the client's guess is
what stops a client one version behind approving a permission prompt by
posting question answers at it.

## Web UI

There is **no Claude Design artboard for these two cards**. The
question card's own vocabulary is reused instead: every class constant
transcribed from canvas 9b/9d moved out of `QuestionCard.tsx` into
`panels/decisionCardStyles.ts`, and both cards import from it. A design
pass is pending; when an artboard lands, that one file is where its
values go.

- **`PermissionCard`** (`panels/PermissionCard.tsx`) draws both kinds:
  chip (`PERMISSION` / `PLAN`) + tool name, the headline, the bridge's
  subtitle when there is one, then the input — a one-line summary for a
  tool that carries a command/path/URL, the plan's markdown for a plan,
  and pretty-printed JSON for everything else.
- **Two buttons**: *Decline* / *Allow once*, or *Keep planning* /
  *Approve plan*. Decline comes first in the DOM so ⇥ lands on the
  refusal, and there is no one-key approve shortcut — nothing on this
  card may be authorised by a stray keystroke, which is what
  `defaultToNo` asks for and costs nothing to apply everywhere.
- **Declining expands a reason field inline**, the way the question
  card's Other… row does; esc collapses it through the app's escape
  stack. Declining with the field closed sends no message and the server
  supplies its own wording.
- **Composer text declines with the text as the reason** — the CLI's own
  "No, and tell Claude what to do differently". See adr
  `typed-text-declines-a-permission-ask`. The composer's hint and
  placeholder say so before anyone presses ⏎.
- **Which rows become cards** (`groupToolRuns`, now taking the pending
  decision's id): `AskUserQuestion` always → question card;
  `ExitPlanMode` always → permission card in its plan form, because its
  input IS the plan and a plan stays worth reading long after it was
  approved; any other tool → card only WHILE the session is parked on
  it. The CLI records the tool call, never the prompt, so once an
  ordinary ask is over there is nothing left to draw a card from and the
  row reverts to its usual `ToolRow`. That is also the feedback: an
  allowed tool runs, a declined one shows its refusal as an errored
  result.
- The store keeps `decisionVerdicts[decisionId]` beside
  `decisionAnswers`, for the same reason — the card flips to its settled
  form on the click, not on the round trip — and because the refusal's
  reason has nowhere else to live: the `tool_result` the client reads
  back carries only the error flag.

## Testing

Boundaries and state transitions, per the project test policy:

- **Runner** — `decisionKindFor` routing; a permission ask parks with
  (and only with) the bridge fields the CLI sent; approve allows with
  the input untouched; decline denies with the reason and leaves the
  session `working`; a payload of the wrong shape for the parked kind is
  refused both ways round; `bypassPermissions` allows a permission ask
  without parking but still parks a question; interrupt/end settle
  exactly once; composer text declines rather than approves; plan
  approval fires `setPermissionMode` and reports the edge, decline does
  not, a non-planning session is not rewritten, and a CLI without the
  control request still settles.
- **Routes** — approve and decline for both verdict kinds, 400 for a
  body that is not a verdict, 400 for a verdict posted at a question,
  404 for an id that is not the parked one.
- **Web (pure)** — `lib/decisionCard`: headline precedence and the
  fallback that never quotes the input, plan extraction, input summary
  precedence, the decline body (blank text sends no message, and it
  never approves). `groupToolRuns`: which rows become cards.
- **Store** — the verdict path posts and remembers, is a no-op on a
  question, treats 404 as resolved; composer text declines and enqueues
  no turn, and never posts answers at a verdict decision.

Not tested: card pixels, labels, classNames.

## Deliberately left out

- **"Always allow"** (`suggestions` → `updatedPermissions`) — adr
  `permission-prompts-write-no-permission-rules`.
- **Choosing the mode an approved plan continues in.** The CLI offers
  "auto-accept edits" or "manually approve"; Orbital's `PermissionMode`
  union has no ask-about-everything member and adding one changes the
  launch picker and its artboard. Adr
  `an-approved-plan-continues-in-acceptedits`.
- **`onUserDialog` blocking dialogs** (open `dialog_kind` union) — the
  last thing on this channel, still unstarted.
- **A history of ordinary permission asks.** Nothing records that a tool
  was asked about, so a settled permission card leaves no trace but the
  tool row itself.
