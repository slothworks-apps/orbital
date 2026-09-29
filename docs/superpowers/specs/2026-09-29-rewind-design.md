---
id: 2026-09-29-rewind-design
title: Rewind — take a session's conversation back to before one of your messages
status: draft
type: spec
domain: sessions
related:
  - narrate-can-lock-a-session-out
  - walkthrough-sits-behind-an-experimental-switch
  - feature-parity-with-the-claude-code-cli
tags:
  - rewind
  - transcript
  - runner
---
# Rewind — take a session's conversation back to before one of your messages

Design: Claude Design, `Feature - Rewind v2.dc.html`, artboards 27a (main
window), 27b (detached window) and 27c (parts). The canvas owns every visual
value; this spec owns behaviour.

## Why

A refused narrate turn locked a session out of every later turn, and Orbital
had no way back ([[narrate-can-lock-a-session-out]]). Beyond that bug, a
message that sent the agent the wrong way costs a terminal trip today. The
CLI's `/rewind` is the model: pick one of your messages, the conversation
goes back to just before it, and its text returns for editing.

## Scope

In:

- Orbital-run sessions (`source === 'web'`), and terminal sessions whose CLI
  has exited — Orbital already takes those over on the next send.
- Conversation only. Files on disk are never touched.
- The rewind happens **in place**: same session id, same planet.
- Entry through ↶ next to Send or by sending `/rewind`; pick mode; the pending
  state; the stop confirmation; the refusal. Detail panel and detached window
  alike.

Out:

- Restoring files (`enableFileCheckpointing`, `rewindFiles`).
- Keeping both branches browsable, and redo after send.
- Rewinding to an assistant message, or to the session's first user message
  (see *Which messages can be picked*).
- A keyboard shortcut.
- Any session a live terminal CLI holds: the read-only composer already
  replaces the whole composer and says to rewind from the terminal.

## Behaviour

1. **Entering.** ↶ next to Send toggles pick mode. Sending exactly `/rewind`
   does the same and is never delivered to the agent. Neither is offered while
   a rewind is pending (Cancel rewind is the way back) or when a terminal
   holds the session. Esc or Cancel leaves pick mode.
2. **Picking.** In pick mode only the user's own messages are targets. Hovering
   one previews the cut: a dashed line with the count, the rows after it
   faded (canvas 27a/27c).
3. **Which messages can be picked.** A human-typed user message in the live
   branch that has conversation before it and comes after the branch's newest
   `compact_boundary`. The first user message of the session has no
   conversation before it (at most start-up attachments), so it is not a
   target. Messages before the newest compaction are not targets either: the
   CLI cannot resume there (see *Verification*). Non-targets render like the
   non-target rows. Messages from the turn that is still streaming are targets
   as soon as their transcript uuid is known (see *Ids*).
4. **Confirmation.** If the session is working, or has running background tasks
   or subagents, the stop dialog opens after the pick. It names what ends and
   offers *Keep running* and *Stop and rewind* (copy and variants: canvas 27c).
   Confirming stops the session. Nothing running, no dialog.
5. **Pending.** The transcript ends just before the picked message, with the
   dashed end marker. The picked message's text goes into the composer, the
   composer strip reads *Rewound · N messages hidden* with *Cancel rewind*, and
   the state line reads REWIND PENDING. The planet on the map looks like a
   session waiting for input. The pending state survives closing the panel,
   the detached window, the session going to sleep and a server restart.
6. **Cancel.** The hidden messages come back and the composer gets back the
   draft that was there before the pick, exactly. Tasks the confirmation ended
   stay ended.
7. **Send.** The rewind becomes permanent: the cut becomes a solid system
   divider *Rewound · N messages removed*, and the edited text goes out as a
   new turn.
8. **Refusal.** If the CLI refuses the truncating resume, nothing is sent, the
   hidden messages come back, the edited text stays in the composer as an
   ordinary draft and the strip goes away. The existing toast says so and the
   errors log gets an entry naming what was restored. Orbital never retries
   the same rewind: the refusal is deterministic.

**The count, N,** is every row that goes, except system dividers, with a
folded tool run counting as one. The preview line, the strip and both markers
show the same number. Only the client knows the folding, so the client
computes N at pick time and sends it with the pick; the server stores it and
hands it back for the markers.

## How it works

### Reading the live branch (prerequisite)

The CLI records a rewind by appending the new branch to the end of the
transcript, its first entry parented to the fork point. The abandoned entries
stay in the file, unmarked. Every Orbital reader walks the file in order
(`transcript/parser.ts` `entriesToMessages`, `extractMeta`, the indexer, the
walkthrough spine, stats, the tail), so after a rewind each of them would show
both branches. Orbital's own SDK sessions already contain such dead ends:
tool calls cut off by an interrupt.

The transcript is therefore read as its **live branch**: one function turns a
file's entries into the entries of the branch that ends at the newest leaf,
keeping uuid-less metadata entries, and every reader calls it between
`parseTranscript` and what it does today.

Orbital writes the walk itself. `getSessionMessages` builds a different
chain, the one the CLI sends to the model, and it does not fit (see
*Verification*). The rule:

1. The chain entries are the `user`, `assistant`, `system`, `attachment` and
   `progress` entries that have a uuid and are not `isSidechain`. Everything
   else passes through untouched. A uuid can appear more than once (the CLI
   re-appends whole ranges); the first occurrence counts.
2. The tip is the newest leaf: the chain entry, latest in the file, that no
   other entry names as its parent.
3. Walk `parentUuid` back from the tip. At a `compact_boundary`, whose
   `parentUuid` is null, continue at its `logicalParentUuid`.
4. Parallel tool calls: each `tool_result` entry parents its own `tool_use`,
   so only the last result is on the walked chain. Every `tool_result` user
   entry whose parent is on the branch joins it.
5. Keep the file's order, filtered to the branch.

```
liveBranch(entries):
  chain  = entries with uuid, chain type, not isSidechain
  parent = { e.parentUuid for e in chain }
  tip    = last e in chain with e.uuid not in parent
  live   = {}
  e = tip
  while e and e.uuid not in live:
    live.add(e.uuid)
    up = e.parentUuid ?? (e is compact_boundary ? e.logicalParentUuid : null)
    e = first entry with uuid == up
  for e in chain: if e is a tool_result user entry and e.parentUuid in live: live.add(e.uuid)
  return entries where not in chain, or (uuid in live and first occurrence)
```

An interrupt's dangling `tool_use` is off this branch: the next prompt
parents to the block before it. The prompt that started a compaction is off
it too in older transcripts (it hangs off the pre-compaction tip); the
compaction mark stands in for it.

**As built (step 2).** Run over every local transcript, the rule above
dropped real conversation, so `server/src/transcript/liveBranch.ts` amends it:

- The walk above is the *spine*. A side branch hanging off it is dead only
  if it holds a human prompt (a rewind, or an old `/compact`). Any other
  side branch is live: parallel and streamed tool calls chain one `tool_use`
  after another and each result parents its own call, so rule 4 alone lost
  every call of a batch whose result did not land last.
- A side branch's `tool_use` with no result is dropped once a later prompt
  is on the spine. That is the interrupt's dangling call; a call of a batch
  still running stays.
- The tip ranks entries by their first occurrence. Ranked by the last one,
  a side leaf the CLI re-appended around a compaction took the tip and the
  branch collapsed to the preserved range.
- A parent the file does not hold, or none past the first entry, continues
  the walk at the chain entry before it in the file. One transcript has
  assistant entries parented to uuids never written, the CLI writes some
  entries before the parent they name, and a session opened with `/clear`
  has a second root.
- Fork points (for the divider) are live entries with a dead side branch
  holding a prompt, whose child on the spine is a prompt too. That second
  condition keeps an old `/compact` from reading as a rewind.

The tail (`watcher/tail.ts`) only handles appends. The per-entry rule
first written here (continue when the parent is the leaf, reload when it is
live) reloaded on ordinary parallel tool calls and missed a rewind whose new
branch opens with an `away_summary`. So the tail holds the file's chain
entries and walks them again on every batch (about a millisecond on the
largest local transcript), built on the first append from the file above
where it started. A batch that takes an entry the client was shown off the
branch publishes `{ event: 'transcript_reset' }` on `session:<id>`, and the
client reads the transcript again; otherwise the batch's live entries are
appended. An append to an abandoned branch is not ignored: it is the newest
leaf, so the transcript goes back there, and the tail resets. Replayed
entry by entry over every local transcript, the tail's view ended identical
to a full read on all of them.

### Ids

Messages parsed from the file carry the entry uuid in their id
(`${uuid}:${block}`). Messages from a live turn do not: the runner mints
`${session}:${seq}:${i}` and drops the SDK frame's `uuid`. The runner keeps
the frame uuids (and sets its own `uuid` on user messages it sends, which
becomes the entry uuid in the file, verified), so every user message has an
entry uuid by the time pick mode needs it. Streamed assistant frames carry
their entry uuid too. The wire message gains an optional `uuid`.

The client sends the picked message's entry uuid. The server resolves the
fork point: that entry's `parentUuid`, the last chain entry before it. The
client never sees that entry, because it is often a system or attachment
entry.

### Pending rewind

A pending rewind is a row in a new table, one per session at most:

| column | meaning |
|---|---|
| `session_id` | the session |
| `target_uuid` | the picked user entry, the start of the turn being dropped |
| `fork_uuid` | its `parentUuid`, what `resumeSessionAt` receives |
| `hidden_count` | N, as the client computed it |
| `text` | the picked message's text, for the composer |
| `prior_draft` | the draft the composer held before the pick, for Cancel |
| `created_at` | |

While it exists, the messages API returns the live branch cut before
`target_uuid`, and the session payload carries `rewindPending: { hiddenCount,
text }`. That is how the detached window and a reload show the same state.

A second table records rewinds that were sent (`session_id`, `fork_uuid`,
`hidden_count`, `at`). The divider is drawn wherever the live branch passes a
fork. With a matching row it carries the count. Without one (a rewind done in
the terminal) it reads *Rewound in the terminal* with no count.

### API

- `POST /api/sessions/:id/rewind { uuid, hiddenCount, draft }`
  - Refused when a terminal CLI holds the session, when a rewind is already
    pending, or when the uuid is not a pickable user entry of the live branch.
  - Otherwise the server stops the session if it has a live query (the
    confirmation has already been answered on the client) and stores the
    pending row.
  - Returns the text for the composer.
- `DELETE /api/sessions/:id/rewind` cancels and returns `prior_draft`.
- Sending is the existing send route. `deliverToSession` checks for a pending
  row before anything else.

### Runner

- `start()` passes `resumeSessionAt` and `resumeDropsTurn` through to the SDK
  options. `resumeSessionAt` gets `fork_uuid`. `resumeDropsTurn` gets
  `target_uuid`, but only when the target is the newest human prompt on the
  live branch: the guard accepts a discarded range of exactly one turn and
  refuses anything with a second user prompt in it. A rewind further back
  omits `resumeDropsTurn` and truncates unguarded. That is safe here because
  the session was stopped and awaited, and the user saw everything being
  dropped.
- **Stopping waits for the process.** `stop()` today closes the input and
  releases the state without waiting for the CLI to exit. A rewind must not
  start a second process on the same file while the first is still writing.
  The runner keeps the pump's promise and the rewind awaits it, with a
  timeout that fails the rewind visibly rather than racing.
- **Send with a pending row:**
  1. Stop any live query and await it.
  2. `start({ resume, resumeSessionAt: fork_uuid, resumeDropsTurn: target_uuid, prompt })`,
     `resumeDropsTurn` only as above.
  3. On the `system`/`init` frame the turn is running: move the pending row
     into the sent-rewinds table. A refusal always comes before `init`.
  4. A refusal is a `result` with subtype `error_during_execution` whose
     `errors[0]` starts with `Resume rejected by --resume-drops-turn:` (or
     `No message found with message.uuid of:`, a fork point the CLI cannot
     load). The query's iterator then throws the same text; the runner
     catches it. On either: delete the pending row, send nothing, record the
     error, and emit a refusal event. The client restores the transcript and
     keeps the draft. The CLI writes nothing to the file on a refusal.
- The pending row is what makes a truncation stick. Until a turn lands, the
  file's newest leaf is still the old branch, and a plain revive would load
  it. Every revive path goes through the pending check.

### After a rewind is sent

- `context_used_tokens` is cleared and the next turn's usage sets it again.
- Compaction failures and background-task rows that belong only to dropped
  turns stop showing, because they are joined against the live branch.
- **Stats:** cost and token totals include the dead branch, since those
  tokens were billed. Turn, tool and message counts cover the live branch
  only.
- **Title:** the titler's in-memory feed is reset from the live branch.
- **Walkthrough:** built from the live branch, so dropped steps disappear.

### As built (steps 3 and 4)

Where the server departs from the design above, or says what it left open:

- **The user's own turn.** The Runner never publishes a turn it sends (the
  SDK does not replay stdin; the client shows its own copy). So the send
  routes answer with `uuid`, the uuid Orbital set on the message, and the
  client puts it on its copy. Every message read from the file carries its
  entry's `uuid`, and so does every live one whose frame had one.
- **Pickable is the server's call.** The messages API marks
  `rewindable: true` on the user rows that can be picked: a human prompt, not
  the harness's (`<local-command-stdout>` and the like have nothing the human
  typed), with an assistant entry or a compaction before it, after the newest
  `compact_boundary`. A user turn just sent counts as pickable once the file
  has it; until then the client can offer it when it is not the session's
  first.
- **The divider is a row of its own**, `role: 'rewind'` with
  `rewind: { hiddenCount }` (null for the terminal). There was no server-side
  divider to reuse: the model divider is drawn by the client. It goes ahead
  of the new branch's first prompt, with the id `rewind:<fork>:<dropped>`.
- **Between init and the new prompt reaching the file** the file's newest
  leaf is still the old branch. `rewinds` keeps `target_uuid` for this: while
  the newest sent rewind's target is still on the live branch, the messages
  API keeps cutting there and puts the divider at the cut, under the id the
  fork's divider takes over once the prompt lands. If the CLI crashed after
  `init` without writing the prompt, the cut would stay; not handled.
- **Stopping.** `Runner.stopAndWait` interrupts a turn in flight, closes the
  input, and after half the timeout closes the query outright. Still running
  at the timeout, the rewind fails with 504 `stop_timeout` and a
  `rewind_failed` error, and nothing is stored. It also waits out a process
  a sleep or an End stopped a moment earlier.
- **Status while pending** is `needs_input`, read in `statusOf` past the
  Runner and the registry, whatever the row's end stamp says.
- **Refusal** is logged as `rewind_refused` (the message names what was
  restored, the detail is the CLI's text) and published as
  `{ event: 'rewind_refused', message, hiddenCount }` on `session:<id>`,
  followed by `transcript_reset`. The pump does not also log it as a failed
  session.
- **The walkthrough's narrate and ask** are refused with 409
  `rewind_pending` while a rewind is pending: the next turn is the edited
  prompt.
- **`/rewind`** is in every session's command list as a `built-in` (the
  catalog has no badge of Orbital's own), and the send route answers exactly
  `/rewind` with 400 `local_command`.
- **The interrupt's dangling call** on Orbital-run sessions: the Runner
  remembers that an interrupt cut a call off, and the end of the turn after
  the next prompt publishes `transcript_reset`. If the interrupted turn's own
  `result` arrives after that send, the reset comes one turn early and the
  call stays until the next reread.
- **Compaction failures** are cut with the turns (those at or past the cut's
  timestamp). Background-task rows are not joined against the branch yet.

## Verification (2026-09-29)

Agent SDK 0.3.278, read-only on real transcripts, and live resumes on a
throwaway haiku session only.

**`getSessionMessages` is not the live branch Orbital needs.** It returns the
chain the CLI would send to the model:

- It stops at the newest `compact_boundary`. Everything before it is gone,
  and the preserved segment is moved after the summary. Orbital shows the
  whole history, so this alone rules it out.
- It starts its walk at the newest user or assistant entry, so the system
  entries after the last turn (`turn_duration`, `stop_hook_summary`,
  `away_summary`, a trailing local command's output) are missing.
- It puts back every block of an assistant message by `message.id`, which
  brings the interrupt's dangling `tool_use` back.
- It leaves out attachments and `isMeta` entries, and gives queued commands
  uuids that are not in the file.
- It does keep parallel tool results, and it does follow a CLI rewind to the
  newest branch.

Orbital's own walk (*Reading the live branch*) matches it on every user,
assistant and system entry after the newest boundary across five large
transcripts, apart from exactly the differences above. It follows a CLI
rewind (the sibling prompts under one parent), drops the dangling
`tool_use`, and crosses compaction by `logicalParentUuid`. It takes a few
milliseconds on the largest local transcript once parsed; the SDK call,
file read included, took about a tenth of a second there.

**A real truncating resume:**

- The fork point is the target's `parentUuid`. In practice that is a
  `stop_hook_summary` or an attachment, and `resumeSessionAt` accepts it.
  Forking at the previous assistant entry is accepted too; the entries
  between are skippable.
- `resumeDropsTurn` wants the uuid of the user entry being dropped, the
  target. A wrong uuid is refused before the prompt is read, with nothing
  written. Dropping two turns with the guard is refused (*a user entry not
  attributable to the declared turn*); without it, it goes through.
- The new branch's first entry, the new prompt, parents to the fork uuid,
  and it carries the uuid Orbital set on the message.
- A truncating resume that never gets a prompt writes only uuid-less
  metadata. Nothing on the chain changes until a turn is sent.
- A plain resume afterwards continues from the new branch.
- Forking before a compaction fails with `No message found with
  message.uuid of:`, with or without the guard. After the boundary it works
  like any other rewind.

## Errors and edge cases

- **The picked message scrolled out of the loaded page.** Pick mode only
  offers loaded messages. To go further back, load more first.
- **Compaction.** The CLI cannot fork before the newest `compact_boundary`,
  so those messages are not targets. If one gets through anyway, its
  `No message found` refusal takes the refusal path.
- **A terminal `claude --resume` later.** The interactive CLI ignores
  `resumeSessionAt`. Once a rewind has been sent, the file's newest leaf is
  the new branch, which the CLI then follows. While a rewind is pending,
  though, a terminal resume would continue the old branch. The pending row
  is cleared when the registry sees a terminal take the session.
- **Server restart while pending.** The row persists and the send path picks
  it up.

## Testing

Worth a test, per the repo's rule:

- **Live-branch extraction**, over fixtures cut from real transcripts: a CLI
  rewind, an interrupt's dangling `tool_use`, parallel tool calls, a
  compaction boundary, duplicate uuids.
- **The rewind routes:** each refusal, stopping a live session, cancel
  returning the prior draft, and the messages API cutting at the target while
  pending.
- **The send path:** a pending row becomes a sent row on success, and the
  refusal path clears it without sending, using a fake runner that returns
  the refusal result.
- **The tail's branch-change detection.**
- **The count**, computed from rendered rows with folding.

Not worth a test: the dimming, the ring, the markers' styling.

## Order of work

1. **Verification spike:**
   - `getSessionMessages` on real transcripts
   - a real `resumeSessionAt` + `resumeDropsTurn` resume: what it writes, and
     which uuid `resumeDropsTurn` wants
   - forking before a compaction boundary

   Done: see *Verification*.
2. The live branch through every reader, shipped on its own. It also fixes
   the dangling tool calls interrupts leave today.
3. Ids for live messages.
4. The server: tables, routes, runner pass-through, stop that waits, the send
   path, the tail.
5. The web: ↶ and `/rewind`, pick mode, pending, the confirmation, the
   refusal, the dividers. Then a fidelity pass against canvas 27a–27c.

When this ships, [[narrate-can-lock-a-session-out]] is done and
[[walkthrough-sits-behind-an-experimental-switch]] can be revisited.
