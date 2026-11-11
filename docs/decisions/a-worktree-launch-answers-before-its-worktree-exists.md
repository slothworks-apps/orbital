---
id: a-worktree-launch-answers-before-its-worktree-exists
title: A worktree launch answers before its worktree exists, and Orbital keeps a record of the setup
type: adr
status: in-force
domain: sessions
related:
  - 2026-11-09-worktree-setup-in-background-design
  - orbital-makes-the-worktree-and-names-its-branch
  - 2026-11-02-work-in-a-worktree-design
  - a-session-ends-only-when-the-user-ends-it
tags:
  - git
  - worktree
  - sessions
---

# A worktree launch answers before its worktree exists

## The problem

[[orbital-makes-the-worktree-and-names-its-branch]] made the worktree
inside `POST /api/sessions`, before the session started. In a large
repository the naming call, `git worktree add` and the copy of the local
files take many seconds, and New Session held the user on its spinner for
all of them. The spec [[2026-11-09-worktree-setup-in-background-design]]
moves the work after the answer. This records the choices that move
forced.

## The decision

- **The launch answers first.** `POST /api/sessions` checks what the
  dialog can still fix (the repository, the base, a typed branch), writes
  the session's row and its setup record in one transaction, and answers
  201. The three steps run after it, and the session starts in its
  worktree when they are done. This supersedes the first bullet of
  [[orbital-makes-the-worktree-and-names-its-branch]].
- **Orbital stores the setup.** A `session_setups` row per worktree launch
  says what has been made on disk, for a rollback after a restart, and
  holds the first prompt and the messages written before the session
  started. This supersedes "nothing about the worktree is stored in
  Orbital's database" in the same ADR. What it said about the session's
  appendix and `gh-merge-base` still holds: the record is about the setup,
  not about the worktree once it runs.
- **`status` stays `idle`, with an optional `setup` beside it.** A client
  that does not know `setup` shows an idle session rather than breaking.
  A Mac that sets up in the background needs no `MAC_FEATURES` gate: the
  new UI appears only for a session that carries `setup`, and the new
  routes are called only from it.
- **A session that never ran is discarded, not ended.** It has no
  transcript to keep, so Discard deletes it and it never appears in Ended;
  End on such a session discards it too. Everything else that ends a
  session does not reach it: Clear answers 409 `in_setup`, and
  `archive_session` refuses it unless forced, when it discards it and says
  so ([[a-session-ends-only-when-the-user-ends-it]]). The retention sweep
  passes over it. A discard keeps the setup's row as a tombstone until what
  the setup made is rolled back, so a restart in between finishes the
  rollback.
- **A session in setup takes nothing but the composer's messages.** Those
  are queued on the setup. Every other delivery (a harness, a limit
  reset, a login's continuation) is refused with `in_setup`, because the
  session's row still names the main checkout and a revive would start it
  there.
- **A launch on a harness carries it through the setup.** The harness is
  attached at the launch and its kickoff kept on the setup's launch
  settings; the setup starts the session on the kickoff, so it is a turn
  the harness records, not a queued delivery. A harness session takes the
  queue into its first turn while it runs, so a queued message never lands
  between a turn's end and the harness's decision to send the next step
  (spec 2026-11-09-worktree-setup-in-background-design § A launch on a
  harness or with a progress list).
- **Boot rolls back an interrupted setup** from its record and leaves the
  session NOT STARTED. A setup whose session the previous server's runner
  had claimed counts as started, even when the setup did not get to write
  so, and its worktree is kept.
- **The queue goes in after the first reply,** oldest first, woken by the
  runner's turn and status edges rather than a timer. A first turn that
  ends on the plan's limit hands the queue to the limit wait, which sends
  it at the reset. A queue a restart left behind stays queued: nothing is
  resumed at boot, and it goes in, ahead of the new message, when the user
  next writes to the session.

## What was ruled out

- **Holding the launch's answer and only moving the spinner elsewhere.**
  The user still cannot launch a second session while git works, which is
  what the change is for.
- **A `status` value of its own for SETTING UP and NOT STARTED.** An older
  phone or desktop would meet a status it does not know.
- **Ending a session in setup into Ended.** Its row there would have no
  transcript, and reopening it would revive a session that never ran in the
  main checkout.
- **Queueing a harness kickoff or a limit continuation on the setup.** A
  harness records the turn its kickoff started; a queued kickoff starts no
  turn, and the harness would run against nothing. A launch's kickoff is
  not queued: it is the turn the session starts on.
- **Sending a queue a restart left at boot.** It would revive a session the
  restart just marked interrupted, against "nothing is resumed; the next
  message revives it".
- **Polling the session's turn.** A first turn can wait hours on a
  permission; a timer would run for all of them.
