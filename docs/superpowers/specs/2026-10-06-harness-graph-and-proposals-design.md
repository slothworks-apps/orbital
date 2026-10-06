---
id: 2026-10-06-harness-graph-and-proposals-design
title: Harness graph and proposals — branching steps, one-off harnesses, edits while it runs
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-session-harness-design
  - 2026-10-02-harness-redesign-design
  - 2026-09-30-assisted-harness-templates-design
  - a-harness-graph-runs-in-one-session
  - a-harness-continues-from-its-checklist-not-a-judge
  - harness-graph-editor-on-the-phone
tags:
  - harness
  - experimental
---
# Harness graph and proposals

Builds on [[2026-09-30-session-harness-design]] and
[[2026-10-02-harness-redesign-design]]. Three changes, one spec:

1. **Branching.** Steps form a graph instead of a list: a step depends on
   others, independent branches are open at the same time, and each step
   keeps its own state.
2. **One-off harnesses.** A harness does not need a template. The agent
   works one out with the user in the conversation and proposes it to the
   same session; the user attaches it with one click.
3. **Edits while it runs.** The user edits the running harness in the
   panel; the agent proposes changes the user accepts.

The choice of graph model and of running it in one session is
[[a-harness-graph-runs-in-one-session]].

## Why

A real piece of work is rarely a straight line. Building a component, the
call-site analysis does not wait for Storybook, and the migration does not
wait for the design-parity gate. A flat list makes the agent (and the user)
wait on things the next step does not need, and one waiting gate stops the
whole harness.

Templates are also the only way in today. For a one-time task, writing a
template first is overhead: the natural flow is to talk the feature through
with the agent, let it lay out the steps, and run them right there. Once
running, the plan changes as the work reveals things — the snapshot is
frozen today.

## Ruled out

- **Branches in their own sessions or worktrees.** The graph is logical;
  one session works it, step by step. See the ADR.
- **Lanes + join, or phases.** Both make steps wait on things they do not
  depend on (a join waits for whole lanes; a phase waits for its slowest
  member). See the ADR.
- **Loops in the graph.** Iteration stays inside a step, as before.
- **The agent editing the harness without the user.** It proposes; the user
  applies. An agent that may rewrite its checklist can drop the gate it
  finds inconvenient.

## The graph

### Model

- `HarnessStep.dependsOn?: string[]` — the ids of the steps this one needs.
  **Absent means "the step before it"** (none for the first step), so every
  template and every running harness written before this change keeps its
  meaning without a migration of its data. An explicit `[]` makes the step a
  root.
- Validation (`validateTemplate` and every edit): each id exists, no step
  depends on itself, the graph has no cycle. The error names the steps.
- Step order in the array stays meaningful: it is the reading order in the
  panel and the default for `dependsOn`. It must be a topological order; the
  editor and `validateTemplate` reject a step that depends on a later one.
- `StepStatus` is unchanged. **Several steps can be `active` at once**: a
  step is `active` when every step it depends on is `done`. A gate that
  waits (`awaiting_approval`) is not `done`, so it holds back exactly its
  descendants.
- `logic.ts`: `activeIndex()` gives way to `readyIndexes(steps, state)`;
  `promote()` activates every pending step whose dependencies are all done.
  `finished` is "every step done".

### Ticking

- `harness_complete_step(step_id, …)` accepts any `active` step. It refuses
  a `pending` step and names what it waits for ("waits for 3, 5"), and it
  refuses a step at its gate as today.
- `harness_status()` returns the graph: each step with its status and
  `dependsOn`, and the instructions of **every** active step.

### What Orbital sends

- **Kickoff:** the checklist with dependencies, and the instructions of
  every step that is active at the start.
- **Advance:** after a tick, the steps the tick unlocked plus the ones still
  open: "Step 4 is done. Now open: 3 (in progress), 6 (unlocked by 4)."
  Each newly unlocked step's `startMessageUuid` is that message.
- **Nudge:** names the open active steps, not one step.
- **Watcher:** gets the graph and every active step's done criteria.
- `onTurnBoundary`'s order is unchanged; "the active step awaits approval →
  wait" becomes "**no** step is active and one awaits approval → wait". When
  a gate waits and other steps are active, the turn continues on them.

### A gate while other work goes on

The user asked for this explicitly: a gate is announced **as soon as it
waits**, not once nothing else is left.

- When the agent ticks a gate step, `harnessGate` becomes `waiting` at the
  tick, and the session is published then, not at the turn's end.
- The session reads **NEEDS YOUR OK** everywhere at once (state row, map,
  NEEDS INPUT count, the phone's group) through the existing `gateWaits`,
  even while the runner reports `working`. The runner's status is not
  overridden on the server; the client already lets `gateWaits` win.
- The state row says both: NEEDS YOUR OK and that the agent is still
  working on other steps. How the planet shows the two at once is for
  Claude Design; until then the planet shows needs-input (steady, as for a
  gate today).
- A notification goes out once, when the gate starts waiting (the same rule
  as a `working → needs_input` turn end, with the gate flip as its
  trigger). `shared/src/notifications.ts` gains that trigger.
- Approving a gate while the agent is mid-turn: the step is done at once
  and its descendants become active; the advance message that names them
  waits for the turn's end (`onTurnBoundary`), like any other advance.
- With lucky on, the reviewer reviews the gate while the agent keeps
  working elsewhere. `harnessGate` is `reviewing` meanwhile, which does not
  ask for the user.

### Records and git

- Ticks are serial (one session). A step's diff is from the HEAD at the
  **previous tick of any step** (or the step's activation, whichever is
  later) to its own tick. `startHead` is updated on every tick for every
  still-active step; `commitPerStep` keeps each range clean.
- **Go back / reopen** set aside the target step and its **transitive
  descendants** only; sibling branches keep their records and their `done`.
  The "before going back" previous runs are kept as today.

## Proposals: one-off harnesses and agent edits

### `harness_propose`

A fourth tool on the `orbital` MCP server, auto-approved and `alwaysLoad`
like the others, while the feature is on. One input, one of:

- `{ harness: { name, steps, inputs?, options? } }` — a whole harness, when
  the session has none. `steps` carry `dependsOn`; inputs come filled in.
- `{ changes: { add?: Step[], update?: Step[], remove?: string[] }, note? }`
  — a change to the running harness.

It is validated as an edit would be (below). An invalid proposal returns the
error to the agent, which fixes it. A valid one is stored and the tool
answers "proposed, waiting for the user" — the agent then ends its turn or
works on.

### The pending proposal

- `session_harness_proposals`: `session_id` (primary key — one pending
  proposal per session), `kind` (`harness | changes`), `body` (JSON),
  `note`, `created_at`. A new proposal replaces the pending one; the old
  one is logged `proposal_superseded`.
- `harnessGate` gains `proposal`: a pending proposal asks for the user like
  a waiting gate does — NEEDS YOUR OK, counted, notified once.
- The panel shows it as a card: for a whole harness, the graph it would
  attach; for changes, the diff (added, changed, removed steps, with their
  dependencies) and the agent's note. Buttons: **Apply** (Attach, for a new
  harness), **Edit** (opens the editor on the proposal; saving applies it),
  **Discard**. The transcript carries a ◆ row "proposed a harness" /
  "proposed changes".
- Routes:
  `POST /api/sessions/:id/harness/proposal/apply` → `{ harness }`,
  `POST /api/sessions/:id/harness/proposal/discard` → `{ ok }`,
  `GET /api/sessions/:id/harness` adds `proposal`. 409 when there is none, or
  when changes no longer apply (the harness moved on; the error says which
  step) — the user discards or edits.
- Applying a whole harness attaches it with `templateId: null` and sends the
  kickoff, as attaching a template does. Applying changes sends an
  `edited` message (a new `HarnessMessageKind`) saying what changed and
  what is open now.
- The proposal does not touch auto-continue. With a harness running, the
  agent goes on with its open steps while a change waits.

### Edits by the user

- The panel's harness has **Edit**, the template editor over the running
  harness. Saving applies the change at once (no proposal).
- Rules for both paths (`applyChanges(harness, changes)` in `logic.ts`,
  pure):
  - a `done` or `awaiting_approval` step cannot be changed or removed — to
    redo one, go back to it;
  - an `active` step can be changed; it stays active if its new
    dependencies are all done, otherwise it goes back to `pending` (its
    record is kept as a previous run, `reason: 'edited'`);
  - a step cannot gain a dependency on a step that is not done when the
    step itself is done;
  - removing a step hands its dependencies to the steps that depended on it;
  - the result passes the graph validation.
- Every applied change logs `edited { by: 'user' | 'agent', diff }`.
- A user edit while the agent is mid-turn: the `edited` message is sent at
  the turn's end.

### Saving as a template

A harness with `templateId: null` (or any) gets **Save as template** in the
panel: the steps as they stand, with the filled-in values left as written
(the user can turn them back into inputs in the editor). The existing
"Draft in a conversation" stays.

## The panel

- **The checklist keeps its list form, with a graph in the gutter**, like
  `git log --graph`: one lane per open branch, lines from a step to the
  steps that need it. A linear harness looks as it does today with a
  single line. Order is the steps' array order.
- The full window (⌥-click on the pill) draws the whole graph, steps as
  boxes with arrows, beside the record.
- The proposal card sits above the checklist while one waits.
- The editor gains "depends on" per step (a multi-select of earlier steps,
  default: the step before).
- All of it is wireframed only; the visual design is drawn in Claude Design
  before it is built.

## The phone

- **Gates on the phone came with 2026-10-05-mobile-next** (the gate card,
  the steps sheet, approve · reopen · go back · decide myself). This change
  makes them read the graph: the step the phone stands at is a waiting gate
  first (`currentIndex` in `web/src/lib/harnessGraph.ts`), the card's "next"
  is the first step that needs the gate, and the steps sheet says what each
  step needs (`← 2, 3`).
- **Proposals:** an amber line under the session header opens the proposal
  card; Attach / Apply or Discard. `…/proposal/apply` and
  `…/proposal/discard` go into `server/src/remote/allowlist.ts`.
- **Editing the graph is left out on purpose**: a dependency editor does
  not fit a phone screen; the card has no Edit there. Written down as
  [[harness-graph-editor-on-the-phone]].

## Events

New kinds: `proposed { kind }`, `proposal_applied { by }`,
`proposal_discarded`, `proposal_superseded`, `edited { by, diff }`.
`ticked` carries `unlocked: string[]`.

## Testing

- `logic.ts`, pure: `readyIndexes` and `promote` on diamonds, multiple
  roots, a gate holding back only its descendants; the implicit
  `dependsOn`; cycle, self and forward-reference rejection; `goBack` and
  `userReopen` resetting only descendants; `applyChanges` for every rule
  above, including dependency hand-over on remove; the git range across
  interleaved ticks.
- `onTurnBoundary`: a waiting gate with other active steps continues; with
  none, waits.
- Routes: apply / discard, 409 on a stale proposal, the allowlist entries.
- `harness_propose`: the validation path returns errors to the agent.
- Existing harness tests keep passing unchanged — the compatibility claim
  of the implicit `dependsOn`.

## As built

Where the build settled what the spec left open or changed it:

- **`harness_propose`** takes `{ harness: { name, steps } }` or
  `{ changes }`, plus `note`. A proposed harness has no inputs and runs on
  the default options; the panel's switches change them after attaching.
- **Edit on a proposal** sends the user's version along:
  `POST …/proposal/apply` takes an optional `{ harness: { name, steps } }`
  or `{ changes }` of the proposal's kind, checked as the agent's would be.
- **The user's edit** is `PUT /api/sessions/:id/harness/steps`
  `{ add?, update?, remove? }` → `{ harness }`. Added steps go at the end;
  an added step without `dependsOn` needs the step before it.
- **Delivery.** An approval, an edit or an applied change that opens steps
  is delivered at once through the composer's path; a running turn takes it
  after the turn, so "waits for the turn's end" holds without a queue of
  its own. Paused, nothing is sent; resuming sends the open steps.
- **The state.** A live session at a waiting gate or proposal stays
  `working` on the server; the client's `sessionStateKey` reads it as
  NEEDS INPUT (worded NEEDS YOUR OK), and the session panel's chip says
  NEEDS YOUR OK · STILL WORKING.
- **Notifications** (`shared/src/notifications.ts`): an upsert that turns
  `harnessGate` to `waiting` or `proposal` while the session stays
  `working` notifies once, "Needs your OK". The turn end that follows,
  `working → needs_input` with the gate still waiting, is not news again.
- **The full window** names each step's needs on its line (`← 2, 3`)
  rather than drawing boxes and arrows; the side panel's gutter is the
  graph.
- **Go back** warns when steps of other branches finished after the target
  step began: they stay done, but the conversation's rewind and the
  `git reset` the dialog offers reach past them.
- **Save as template** writes the running steps as a template of the
  session's project and opens it in Settings.

## Open

- How the planet shows NEEDS YOUR OK and still-working at once (Claude
  Design).
- Whether the reviewer's diff for a gate should exclude commits from other
  branches made while it waited (today: the range ends at the tick, so it
  already does).
