---
id: 2026-09-30-session-harness-design
title: Session harness — a template's checklist that a session follows to the end
status: done
type: spec
domain: sessions
related:
  - walkthrough-sits-behind-an-experimental-switch
  - 2026-09-18-auto-title-design
tags:
  - harness
  - runner
  - experimental
---
# Session harness — a template's checklist that a session follows to the end

No design on the Claude Design canvas yet. The UI here is built from the
existing panels and primitives and is to be redrawn once artboards exist.

## Why

An agent on a feature branch often stops after the preparation — a spec,
docs, "shall I continue?" — although the work it was given goes on. The
same kind of work repeats with the same shape. Building a new component,
for instance, is always: load the design, the legacy component and its
usage analysis → build it → Storybook → parity design vs Storybook → tune
the API → migrate the legacy call sites → test → review from several
angles → PR with screenshots.

A **harness template** writes that shape down once. Put into a session, it
becomes a checklist the session follows and ticks off. Orbital, not the
user, sends the agent on to the next step whenever nothing needs the user.

## What we ruled out

A spike on 63 real turn ends from `~/.claude/projects` (2026-09-30) asked
whether a judge that sees only the agent's last message can tell a needless
"shall I continue?" from a real stop. Always answering STOP scored 0.698.

| judge | accuracy |
|---|---|
| laya multilingual, `noul` (zero-shot) | 0.32–0.40 |
| laya typed-decisions, `noul` | 0.33–0.70 |
| laya, `choice` "why did it stop" | 0.698 |
| Haiku, tuned prompt | 0.698 |

None beat the majority class. The last message does not say whether a
question is a gate the user wants; the plan does. So:

- **No free-standing continue judge.** The checklist decides.
- **No laya for now.** Zero-shot it is uncalibrated (`noul` ≈ 0.9 on
  everything). Every watcher decision and the user's reaction to it is
  logged (`harness_events`), which is the dataset a fine-tune would need.
- **No orchestrator that runs each step as its own session.** Component work
  is iterative and each step leans on the context of the last.
- **No loops between steps.** Iteration happens inside a step: a step is
  done when its done-criteria hold, however many rounds that takes. The user
  can reopen a step by hand.
- **No markdown files as the source.** Templates live in Orbital's database
  and are edited in its UI.

## Model

### Template

`harness_templates`: `id`, `name`, `description`, `tags` (JSON string
array), `inputs` (JSON), `steps` (JSON), `created_at`, `updated_at`.

- **Input**: `{ key, label, hint? }`. Values are given when the template is
  put into a session, and `{{key}}` in step instructions is replaced by them.
- **Step**: `{ id, title, instructions, mode, doneWhen, verify? }`
  - `mode`: `auto` — Orbital moves on by itself once the step is done;
    `gate` — once the step is done it waits for the user's approval.
  - `doneWhen`: plain-language criteria the agent ticks against.
  - `verify`: optional shell command run in the session's cwd. Exit 0 is
    required to tick the step; its tail comes back to the agent otherwise.

Steps are a flat ordered list, stored whole: the editor saves the template
as one document.

### A session's harness

`session_harnesses`, one row per session (`session_id` primary key):
`template_id` (nullable — the template may be deleted later),
`name`, `steps` (a **snapshot** of the template's steps with the inputs
already filled in), `inputs` (the values), `state` (JSON per step: `status`,
`evidence`, `completedAt`), `paused`, `auto_rounds`, `idle_nudges`,
`created_at`, `updated_at`.

Editing a template never changes a session that already runs it.

Step status: `pending` → `active` → `done`, or for a gate
`active` → `awaiting_approval` → `done`. The active step is the first one
not `done`.

`harness_events`: `id`, `session_id`, `at`, `kind`, `detail` (JSON). One row
per tick, verify failure, nudge, watcher verdict, approval, pause. The log
the UI reads and the dataset for later.

## How it runs

### Attaching

In the session's Harness panel the user picks a template and fills its
inputs. Orbital stores the snapshot and sends the session a kickoff message:
the checklist, the inputs, how to tick, and the first step's instructions.
A session has at most one harness; removing it stops the automation and
keeps the transcript.

### The agent's tools

Every session Orbital runs gets an in-process SDK MCP server `orbital` with:

- `harness_status()` — the checklist with statuses and the active step's
  instructions. Answers "no harness" when there is none.
- `harness_complete_step(step_id, evidence)` — ticks the active step. Runs
  `verify` first when the step has one. Refuses a step that is not the
  active one. For a gate step the status becomes `awaiting_approval`.

The tools are auto-approved through `allowedTools` (ticking is bookkeeping,
not an action on the world) and marked `alwaysLoad`, so the agent does not
have to find them through ToolSearch first. The server is added only while
the feature is on, and a session gets it when its process starts: a session
already running when the switch is turned on sees the tools after its next
revive.

### At the end of a turn

`onTurnBoundary(ended)` hands the turn to the harness. Nothing happens when
there is no harness, it is paused, or the experimental switch is off. Then,
in order:

1. **Someone else holds the turn** — a permission question is parked, or
   background work is live: wait. The next turn end asks again.
2. **All steps done**: say nothing; the harness is finished.
3. **The active step awaits approval**: wait for the user.
4. **Caps**: `auto_rounds` ≥ 40 or `idle_nudges` ≥ 2 → pause with a reason.
5. **A step was ticked this turn**: if the agent said nothing after its
   last tick, send the next step's instructions ("continue with step N+1").
   If it did speak after the tick, it may have moved on and hit a real
   question in the next step, so the watcher decides; its CONTINUE sends the
   next step's instructions without counting as a nudge.
6. **Nothing was ticked**: ask the **watcher** (below). `continue` → send a
   nudge for the active step, `idle_nudges` + 1. `stop` → wait for the user.

Every message Orbital sends on its own (an advance or a nudge) counts in
`auto_rounds`; the kickoff and an approval's next step are the user's doing
and do not. A message the user types resets `idle_nudges`, and resuming a
paused harness resets both.

### The watcher

A one-shot model call through the same path as the titler (Haiku by
default). It gets the checklist, the active step with its done-criteria and
the agent's last message, and answers `CONTINUE` or `STOP: <reason>`.
It stops when the agent needs a real decision or information only the user
has, or the next thing is outward (push, merge, PR, deleting data). It
continues when the agent is only asking permission for work the checklist
already covers. This is the context the spike's judges did not have.

A failed call is recorded and read as `STOP`.

### Approving a gate

In the panel, a step in `awaiting_approval` shows **Approve** and **Reopen**.
Approve marks it `done` and sends the next step's instructions (or nothing
when it was the last). Reopen sets it back to `active` without sending
anything — the user writes what they want changed.

## UI

- **Settings → Harness templates** (listed only while the feature is on):
  the list with tags, and an editor for name, description, tags, inputs and
  steps (add, remove, reorder, mode, done criteria, verify command). Saved
  whole; the server's validation message is shown as is.
- **Session → Harness panel**: the third tenant of the side slot the
  subagent panel and the task output share, opened from a `HARNESS 2/5`
  chip in the header (`+ HARNESS` without one; the needs-input colour while
  a gate waits). Without a harness: template picker and input form. With
  one: the checklist with status, instructions, evidence, Approve / Reopen,
  the auto-continue switch with the harness's own pause reason, the log, and
  Remove.

The whole feature sits behind the existing Experimental switch.

## Testing

- The turn-end decision is a pure function of harness state and session
  facts: table-tested.
- The step state machine (tick, verify failure, gate, reopen): unit tests.
- Routes: template CRUD, attach/remove/approve/pause, validation.
- The watcher's reply parsing.
