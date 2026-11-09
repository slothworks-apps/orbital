---
id: 2026-11-09-worktree-setup-in-background-design
title: Worktree setup in the background — a session in a worktree starts without waiting
type: spec
status: done
domain: sessions
related:
  - 2026-11-02-work-in-a-worktree-design
  - orbital-makes-the-worktree-and-names-its-branch
  - a-worktree-launch-answers-before-its-worktree-exists
  - 2026-10-03-usage-limits-design
tags:
  - git
  - worktree
  - new-session
  - ui
---

# Worktree setup in the background

## Why

Launching a session in a worktree (spec 2026-11-02-work-in-a-worktree-design
§ Launch) makes the worktree before the session exists: the model names the
branch, `git worktree add` checks out the whole repository, the local files
are copied. Only then does `POST /api/sessions` answer, and until it does
New Session sits on its spinner. In a large repository the checkout alone
takes many seconds, and the user can do nothing else meanwhile. Orbital is
for running several things at once; a dialog that holds the user while git
works is the opposite.

## What changes

Confirming New Session with a worktree closes the dialog at once. The
session exists from that moment: it is on the map, in the lists, can be
opened, and shows its first prompt. The worktree is made in the background.
When it is ready the session starts on its own, with nothing to press.
Sessions launched without a worktree are unchanged.

Design: Claude Design artifact `KFq2bwF8pqjf3W8BWNetG9`, file
`Feature - Worktree in background.dc.html`, artboards 66a (in situ), 66b
(map and Desk), 66c (panel parts) and 66d (phone). The visual values come
from there and are not repeated here.

## Scope

- **For:** everyone who launches sessions in a worktree, on the Mac and on
  the phone.
- **Where it lives:** on by default. It replaces the waiting dialog; there
  is no option to keep it.
- **What an existing user notices after updating:** New Session with a
  worktree closes at once; the new session shows SETTING UP until its
  worktree is ready, and NOT STARTED with a way out if it could not be made.
- **What can be set:** nothing.
- **Out of scope:**
  - a progress bar or a percentage, and any running timer;
  - a notification, toast or sound for ready or for failed;
  - removing a single queued message;
  - queuing messages for sessions without a worktree (they start at once,
    as today).

## The two new states

Both are states of an Orbital session that has not started its process yet.
They exist only for a session launched in a worktree.

- **SETTING UP** — the worktree is being made. Three steps, in this order:
  1. *Naming the branch* — the naming call. Skipped (done at once) when the
     user typed the branch.
  2. *Checking out the repository* — reserving the directory and
     `git worktree add`, then the PR target (`gh-merge-base`) when the base
     is not the default branch.
  3. *Copying local files* — `ALWAYS_COPIED` and `worktree_copy_patterns`,
     then the `info/exclude` line.

  The steps run in sequence, as in the 2026-11-02 spec's Launch; running the
  naming call and the checkout side by side is left out, so the block's
  "step n of 3" stays true (our call). The branch is unknown during step 1
  and known from step 2 on; it fills in where it was missing (panel header,
  block, Desk card, phone row).
- **NOT STARTED** — making the worktree failed. Whatever the launch made on
  disk was taken away again (the existing `rollbackLaunch`), so nothing is
  left behind. The session keeps its first prompt and its queued messages
  and waits for the user's choice.

When the worktree is ready the session starts with its first prompt and
moves into its ordinary states (WORKING, then whatever follows). There is no
READY state of its own: "Worktree ready" is only what the setup block says.

Neither new state is ever amber, ever counts as needing input, and never
raises a notification. NEEDS INPUT still wins the glance.

## Behaviour

### Launch

`POST /api/sessions` with `worktree`:

1. Checks synchronously what is cheap and what the user can fix in the
   dialog: the directory is in a git repository, the base resolves, a typed
   branch is a valid name and does not exist. These refusals answer exactly
   as today, with the same status and error code each has now, and keep the
   dialog open.
2. Writes the session row and its setup record (below) in one
   transaction, and answers 201 with the session id. The dialog closes on
   that answer.
3. Runs the three steps in the background, publishing the session row on
   every step change so every client follows.
4. On success, starts the session in the worktree exactly as a launch does
   today — the title from the naming call, the subdirectory inside the
   worktree when it exists — with the first prompt, and is `ready` from
   there. The queued messages go in, in order, once the first prompt's
   turn has ended, as if the user had typed them after its reply. A
   window that had the session open while it was set up follows it into
   the worktree (its branch status included).
5. On failure — in any of the three steps, or after them: the `.mcp.json`
   decisions not written into the worktree, the session process not
   starting — rolls back, records the error in the error log
   (`kind: 'worktree_failed'`, with the session id), and sets the session
   NOT STARTED with one plain sentence saying why.

The launch's replay of a repeated session id (`launchReplays`) keeps
working: a repeat gets the same 201.

Until the worktree exists, the session row's `cwd` is the launch directory;
it changes to the worktree (or the subdirectory inside it) when the session
starts, and the row written at launch is updated rather than inserted
again. A session in setup does not count as working in the main checkout,
so it does not turn on the Worktree switch for the next launch there (our
call).

### Messages while setting up or not started

`POST /api/sessions/:id/messages` to such a session does not start
anything. The message is added to the session's queue and the answer is
`{ ok: true, queued: true }`, as for a session waiting for a limit reset.
The queue is shown as the existing queued-turn bubble with the caption the
design gives ("queued · sent when the session starts"; after a failure,
"kept, not sent"). Queued messages cannot be removed one by one. They go
out in order after the first prompt's turn has ended: until then the
started session keeps them in its `setup.queued`, drawn as queued turns at
the bottom of the transcript ("queued · sent after the first reply"), and
a message written meanwhile joins the end of them. A session ended before
its first turn did gets none of them; the error log keeps their text. Each
leaves the setup record only once it has been handed to the session, so a
server that stops in between neither loses nor repeats one (our call); a
stop waits for a delivery in flight to be recorded. One the session does
not take (a terminal holds it, it is gone) is recorded in the error log
with its text, never dropped unsaid.

The handover waits on the runner's turn and status edges, not on a timer:
a first turn parked on a permission for hours costs nothing meanwhile. A
first turn that ends on the plan's usage limit hands the queue, in order,
to the session's limit wait (spec 2026-10-03-usage-limits-design), which
sends it at the reset with whatever is written to the waiting session
after.

Only the composer's messages are queued. Every other delivery into a
session in setup — a harness kickoff or its next step, a limit reset, a
login's continuation — is refused (`in_setup`; attaching a harness answers
409 `in_setup`): the session has no process and no transcript, and the
directory on its row is still the main checkout, where a revive would
start it.

### Ways out of NOT STARTED

The setup block (desktop) and the ⋯ sheet (phone) offer four:

- **Try again** — the same launch settings, from step 1 (a fresh naming
  call, a fresh directory). The session returns to SETTING UP in place.
- **Without a worktree** — opens New Session with this session's settings,
  Worktree off, and the first prompt with the queued messages below it,
  with their attachments. When that launch answers 201 the client discards
  this session; cancelling New Session leaves both as they were. A discard
  that is lost leaves only a NOT STARTED session behind (our call).
- **Copy prompt** — copies the first prompt and the queued messages as one
  text, separated by blank lines. Client only.
- **Discard** — see below.

"Detail" in the block opens the session's `worktree_failed` entry in the
error log, which the map's "!" also lists. There is no error toast for a
failed setup: it is said once, in the session. The client does not raise
the usual log toast for a `worktree_failed` record that belongs to a
session in NOT STARTED.

### Discard

A session that never ran has no transcript to keep, so ending it is
discarding it. The strip's End button keeps its place and ⌘⌫; while setting
up it reads *Cancel setup and discard*, when not started *Discard*. It opens
the End dialog's shell with the discard words, and **Copy prompt** beside
Discard (66c; on the phone the discard sheet, 66d).

Discarding cancels a setup still running, rolls back what it made, and
deletes the session row and its setup record. The session never appears
in Ended; clients drop it as they drop an ended drafting conversation (the
`sessions` topic's `remove`).

A step in flight is not killed: the naming call's answer is ignored, and a
`git worktree add` in progress is allowed to finish and is then rolled
back. The session disappears from the clients at once; the cleanup follows
on the server. Until it is done the setup's row stays as a tombstone
(phase `discarded`), so a server that stops in between finishes the
rollback at its next boot. Discard lets go of what End does besides: the
session's terminals, its harness, its limit wait and its place on a
login's continuation list.

### While setting up, the panel hides what needs a running session

Stats, harness and Clear are hidden until the session runs (66c, strip).
Pin stays. Rename and Change tag work at once.

A Clear that reaches the server anyway (an older client, the
`clear_session` control tool) answers 409 `in_setup` and changes nothing:
clearing would discard the session's first prompt and queue, and start an
empty session in the main checkout.

### Other sessions and the clock

- `list_sessions` (the `orbital` MCP tools) lists such a session with
  `setup: 'setting_up'` or `'not_started'` beside its `idle` status.
- `archive_session` refuses it, saying it has not started; with `force`,
  which the tool is told to pass only when the user asked for exactly
  that, it discards it and answers `discarded` (ADR
  a-session-ends-only-when-the-user-ends-it).
- The retention sweep ("Delete sessions older than") passes over it, as it
  does a pinned one: its first prompt and queue live nowhere else. A
  session whose setup is `ready` is swept like any other, its setup row
  with it.

### A server that stops during setup

The setup record is in the database, so a restart finds it. At boot, a
setup that was still running is rolled back (the record says what had been
made, and says so until the rollback is done) and the session becomes NOT
STARTED with "Orbital stopped while the worktree was being set up." Its
prompt and queue are kept.

A stop waits a little for a session start in flight, so that it is
recorded. A setup whose session the previous server's runner had claimed
counts as started at boot even when the setup did not get to record it:
its worktree is kept, and the session is ready.

A started session whose queue had not all gone in keeps it, still shown as
queued. Nothing is resumed at boot (spec
2026-09-24-sessions-end-only-by-hand-design § 5): when the user next writes
to the session, the queue goes in first, oldest first, and their message
after it.

## Data

A new table `session_setups`, one row per session in setup or not started,
keyed by session id:

- the phase: `naming`, `checkout`, `copy`, `failed`, `ready`, or
  `discarded` for a tombstone whose rollback is not done;
- the branch and the worktree path once known;
- what has been made so far, for a rollback after a restart (directory
  reserved, worktree added);
- the launch settings needed to start or retry (cwd, base, typed branch,
  prompt, attachments, permission mode, model, tag, Claude directory,
  `mcpjson` decisions);
- the queued messages, in order;
- for a failure, the sentence and the error log id;
- when setup started and, once ready, how long it took.

The row is deleted when the session is discarded, once what its setup made
is rolled back. When the session starts,
the row is kept with phase `ready` and its duration, so the setup block can
still say "Worktree ready · ready in 14 s" where it was (our call: the block
keeps its place in the transcript for the life of the session, so nothing
moves when it changes). A migration adds the table; existing data is not
touched.

The API's session shape gains an optional `setup`: the phase, the step
number, the branch, the duration once ready, and for a failure the
sentence and the error id. `status` stays one of today's values — `idle`
while setting up or not started — so a client that does not know `setup`
shows an idle session rather than breaking (our call). A client that knows
`setup` takes it first.

## Where it shows

All as drawn in 66a–66d:

- **Map (Planets):** SETTING UP is a planet being born, NOT STARTED a still,
  dimmed one with a neutral pill. Ready is one continuous change into the
  working planet. Same tag hue throughout.
- **The map's readout:** `… N WORKING · N SETTING UP · N NEEDS INPUT · N
  INTERRUPTED · N NOT STARTED · N DONE …`, both new ones only when non-zero.
- **Desk:** the card's pill and its tool line say the step, or that it did
  not start.
- **Panel:** state chip, the setup block under the first prompt, the queued
  bubbles, the composer's placeholder and hint, the strip as above.
- **Phone:** the list's groups are NEEDS INPUT, WORKING, SETTING UP, WAITING
  FOR LIMIT, NOT STARTED, IDLE, pinned, then the ENDED fold; the session
  screen with the block in phone sizes; the ⋯ sheet (Try again, Start
  without a worktree, Copy first prompt, Discard while not started; Rename,
  Change tag, Copy first prompt, Cancel setup and discard while setting
  up); the discard sheet.

## The phone

Built for the phone too: it launches through the same `POST /api/sessions`
and shows the same sessions.

- **Allowlist:** the new routes (Try again, Discard) join the `sessions`
  group in `server/src/remote/allowlist.ts`.
- **A phone ahead of its Mac:** an older Mac never sends `setup` and still
  answers a worktree launch after the worktree is made; the phone's New
  Session waits as it does today. The new UI appears only for a session
  that carries `setup`, and the new routes are called only from it, so no
  `MAC_FEATURES` gate is needed (our call; add one if a phone path turns out
  to call a new route without a `setup` in hand).
- **A Mac ahead of its phone:** an older phone sees a setting-up session as
  idle, and its messages are queued by the Mac. It cannot retry or discard
  a NOT STARTED session other than through End, which the Mac treats as
  discard for such a session.
- **Without a worktree on the phone:** opens the phone's New Session
  prefilled the same way. If the phone's New Session cannot take a prefill
  today, adding it is part of this work.

## Tests

- Server, end to end: a worktree launch answers before the worktree exists
  and the session starts once it does; messages sent meanwhile go out in
  order after the first prompt; a failure rolls back, records and leaves
  NOT STARTED with the prompt and queue; Try again from NOT STARTED; Discard
  while setting up and while not started leaves nothing on disk and no
  session; a setup interrupted by a restart is rolled back at boot, a
  discard's tombstone too; a queue a restart left waits for the next
  message; Clear and a harness are refused during setup; the synchronous
  refusals still answer 4xx.
- Server, the setup's runs against fake steps: the queue waits on the
  runner's edges, goes to a limit wait, and records what was not taken; a
  close during a start or a delivery still records it; nothing a failure
  throws is left unhandled.
- Server: `list_sessions` and `archive_session` on a session not started;
  the retention sweep passes over it.
- Web: the state logic that turns `setup` into what the clients show
  (state, group, readout counts, which actions are offered).

## Shipping

- Desktop: minor (a new behaviour of New Session).
- Phone app (over the air): minor (new states and actions).
- Phone native shell, relay: none.
