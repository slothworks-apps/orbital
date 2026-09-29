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
   branch that has a predecessor in the chain. The first user message of the
   session has none, so it is not a target; it renders like the non-target rows.
   Messages from the turn that is still streaming are targets as soon as their
   transcript uuid is known (see *Ids*).
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
`parseTranscript` and what it does today. Parallel tool calls also make
parents with several children, so "follow `parentUuid` back from the last
entry" is not the rule by itself. The SDK's `getSessionMessages` already
builds this chain.

**The first implementation step verifies that:** whether
`getSessionMessages` keeps parallel tool results, attachments and system
entries, how it treats `compact_boundary` (`parentUuid: null`,
`logicalParentUuid`), and how fast it is on the largest local transcript.
If it holds up, the live branch is its uuid set applied to Orbital's own
parsed entries. The fragile part then belongs to the SDK. If not, Orbital
writes the walk itself, following `logicalParentUuid` across compaction, and
the investigation's evidence files become test fixtures.

The tail (`watcher/tail.ts`) only handles appends. When an appended entry's
parent is not the current leaf, the branch changed, and the tail tells
clients to reload the transcript rather than appending.

### Ids

Messages parsed from the file carry the entry uuid in their id
(`${uuid}:${block}`). Messages from a live turn do not: the runner mints
`${session}:${seq}:${i}` and drops the SDK frame's `uuid`. The runner keeps
the frame uuids (and sets its own `uuid` on user messages it sends, which the
SDK documents as the entry uuid), so every user message has an entry uuid by
the time pick mode needs it. The wire message gains an optional `uuid`.

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
  options. `resumeDropsTurn` gets `target_uuid`; which uuid the CLI actually
  expects is verified in the first step, together with the rest.
- **Stopping waits for the process.** `stop()` today closes the input and
  releases the state without waiting for the CLI to exit. A rewind must not
  start a second process on the same file while the first is still writing.
  The runner keeps the pump's promise and the rewind awaits it, with a
  timeout that fails the rewind visibly rather than racing.
- **Send with a pending row:**
  1. Stop any live query and await it.
  2. `start({ resume, resumeSessionAt: fork_uuid, resumeDropsTurn: target_uuid, prompt })`.
  3. On the first sign the turn is running, move the pending row into the
     sent-rewinds table.
  4. On a result whose message starts with `Resume rejected by
     --resume-drops-turn:`, delete the pending row, send nothing, record the
     error, and emit a refusal event. The client restores the transcript and
     keeps the draft.
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

## Errors and edge cases

- **The picked message scrolled out of the loaded page.** Pick mode only
  offers loaded messages. To go further back, load more first.
- **Compaction.** Picking a message before a `compact_boundary` depends on
  whether the CLI accepts that fork point, which the first step verifies. If
  it refuses, those messages are not targets.
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

   The answers go into this spec before step 2.
2. The live branch through every reader, shipped on its own. It also fixes
   the dangling tool calls interrupts leave today.
3. Ids for live messages.
4. The server: tables, routes, runner pass-through, stop that waits, the send
   path, the tail.
5. The web: ↶ and `/rewind`, pick mode, pending, the confirmation, the
   refusal, the dividers. Then a fidelity pass against canvas 27a–27c.

When this ships, [[narrate-can-lock-a-session-out]] is done and
[[walkthrough-sits-behind-an-experimental-switch]] can be revisited.
