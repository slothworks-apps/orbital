---
id: the-editor-is-a-second-route-to-one-verdict
title: The editor's diff is a second route to a decision, never the route
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-ide-bridge-design
  - 2026-09-23-permission-and-plan-decisions-design
  - orbital-speaks-to-the-ide-itself
  - an-approved-plan-continues-in-acceptedits
tags:
  - ide
  - runner
  - permissions
---
# The editor's diff is a second route to a decision, never the route

## The problem

The IDE extension's `openDiff` is an approval flow already built by somebody
else: it shows a human two versions of a file in their own editor, with their
own syntax highlighting and their own surrounding code, and does not answer
until they accept or reject. Orbital now has permission asks to approve
(`2026-09-23-permission-and-plan-decisions-design`), so the two could be
joined.

The question is what joining them means. An approval flow that exists in two
places at once has two ways to go wrong, and both are serious: the decision
can be answered twice, or it can become answerable only in the editor — which
would make a feature that is optional by construction into a dependency.

## What was decided

**The browser card owns every decision. The editor is offered a look at the
same one, and whichever answers first wins.**

Concretely, in `Runner.decide()`:

- the decision is parked, published and the session put in `needs_input`
  **before** anything touches the editor. Every line of that path is what it
  was before this feature existed;
- *then*, if an editor covers the session's `cwd` and lists `openDiff` and
  `close_tab`, and the ask is an edit whose result Orbital can compute, a diff
  tab is opened for it. Nothing is awaited and nothing can stop the card;
- `settleDecision` stays the single settle, and it now also aborts the review,
  which drops the tab. A verdict reaching the decision by any route leaves no
  tab behind and no second answer on its way.

### The guard that makes two routes safe

`settleDecision` already settled exactly once — it clears `s.decision` before
resolving, so a re-entrant path finds nothing left. That is enough for one
route. It is **not** enough for two: a verdict arriving late from a review
whose decision is long gone would find a *different* decision parked and
answer that one.

So the editor's route checks the id as well as the parking:

```ts
if (!s || !parked || parked.pending.id !== decisionId) return false;
```

This is the one way two routes could ever settle one decision wrongly, and it
is what `runner.test.ts` pins under the name *a verdict for a decision that is
no longer parked settles nothing*.

### Closing the tab is not an answer

`openDiff` answers `TAB_CLOSED` when the human dismissed the tab without
deciding. That is **not** a verdict — it says "not here", neither yes nor no —
so it resolves to null and the decision stays parked for the browser. The same
null covers an editor that quit, a call that failed, and a review abandoned
because the browser got there first: one value for every kind of no-answer,
and it never changes anything.

### Which asks get a diff

Only `permission`, and only `Write` / `Edit` / `MultiEdit`. A question is the
model asking the human something and a plan is not a file, so neither is a
diff. The three edit tools are exactly the ones whose input both *determines*
the resulting file and can be rewritten to produce any other file — see
[[a-hand-edited-diff-comes-back-as-the-tools-own-input]].

## What was ruled out

**Routing approvals through the editor when one is running.** It reads as the
nicer experience and it is the one thing this must never become. The editor is
ambient state of the machine: it can quit between the ask and the answer, and a
session that could then only be unblocked by relaunching an editor would have
turned an optional bridge into a dependency. The rule is the same one the whole
bridge is built on — every failure is silence, and silence must land on the
behaviour Orbital already has.

**Telling the browser that a diff is open.** It would mean a decision's
envelope carrying editor state, a second reason for the card to re-render, and
a card whose meaning depends on something happening on another screen. The card
is unchanged and unaware, which is also what makes "the editor quit" a
non-event rather than a state to recover from.

**A deadline on `openDiff`.** The thing it waits for is a person reading a
diff; any timeout at all turns "still reading it" into a lost verdict. It is
the only call on this socket with no deadline, and the cancellation that
replaces one is `AbortSignal` + `close_tab`, both owned by the settle.

## What follows from it

- Four failure modes resolve to the same two sentences. *The editor quits
  mid-diff* and *the tab is closed*: null, decision stays parked, browser
  answers. *The browser answers first* and *the session aborts or ends*:
  `settleDecision` runs once, aborts the review, drops the tab, and the late
  verdict is refused by the id check.
- `openDiff` never returning is not a failure mode that needs handling. The
  promise stays pending, holding nothing: the CLI is blocked on the parked
  decision either way, and the settle abandons the wait.
- A session with no editor is fully workable, and so is one whose extension
  does not list `openDiff` or `close_tab`. `close_tab` is required, not
  optional: without it an abandoned review would leave a tab nothing can drop,
  which is worse than not offering the route at all.
