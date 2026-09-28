---
id: 2026-09-28-context-compaction-design
title: Context compaction — live state, transcript mark, failure
type: spec
status: active
domain: map
related:
  - context-fill-arc
  - 2026-09-17-error-surface-design
  - 2026-09-24-state-colours-design
tags:
  - map
  - runner
  - transcript
---

# Context compaction

While Claude Code compacts a session's context, Orbital shows it: on the
planet, in the transcript and in the detail panel. When it ends, the transcript
keeps a permanent mark saying what happened. A failed compaction is recorded
where a developer can read and copy it.

Design source: Claude Design, `Feature - Context compaction.dc.html`,
artboards **26a** (map in situ), **26b** (state sheet), **26c** (detail
panel), **26d** (the permanent mark) and **26e** (timing, surfaces). This spec
overrides the canvas where the two disagree. Every deviation is listed under
[Deviations from the canvas](#deviations-from-the-canvas).

## What the SDK and the transcript give us

Verified against the bundled CLI (`@anthropic-ai/claude-agent-sdk` 0.3.278)
and 18 real `compact_boundary` entries under `~/.claude/projects`, on
2026-09-28.

| fact | Orbital session (live SDK stream) | terminal session (transcript file) |
|---|---|---|
| compaction started | `system/status` with `status: 'compacting'` | — |
| compaction ended | `system/status` with `status: null` and `compact_result: 'success' \| 'failed'` | — |
| error text | `compact_error` on that same status message (the CLI strips it only for Remote Control bridge sessions) | not verified; see below |
| trigger, tokens before | `compact_boundary.compact_metadata.trigger`, `.pre_tokens` | `compactMetadata.trigger`, `.preTokens` |
| tokens after | `.post_tokens`, **optional**: absent in 2 of the last 6 real entries | `.postTokens`, same |
| duration | `.duration_ms` (optional); also measurable from the two status messages | `.durationMs`, present in every real entry |
| summary text | the synthetic user frame that follows the boundary (`isCompactSummary` in the transcript) | same, `isCompactSummary: true` |

What we do not have, and do not compute or estimate:

- **Progress.** No percentage and no time left. The CLI has an internal
  `compact_progress` event, but it is `@internal`, missing from the public
  types, and must not be used.
- **The summary's token count.** Nothing reports it. The mark shows no number
  for the summary.
- **Tokens after, when `post_tokens` is absent.** The mark shows only the
  figure before. There is no arrow and no invented "after".
- **A failed compaction in a terminal transcript.** None of the 18 real
  compactions failed, so there was nothing to read. Terminal sessions get
  no failure mark until one is seen in a real transcript and this spec is
  updated.

Duration is the one derived value allowed. For Orbital sessions, when
`duration_ms` is missing, take the time between the `compacting` status and
the ending status.

Real compactions took 74–156 s. The timer must read naturally past a
minute (`m:ss`).

The `status` messages sit behind a CLI feature flag that defaults to on. If
they ever stop arriving, the live state simply never appears. The mark still
comes from `compact_boundary`, so that must keep working on its own.

## Server

### Live state

The runner handles `system/status` in `pump()`:

- `status: 'compacting'` starts a compaction. The session carries
  `compacting: { startedAt: number; trigger: 'manual' | 'auto' }` until it
  ends.
- A `status` message with `compact_result` ends it. `status: 'requesting'`
  and a bare `status: null` with no `compact_result` are ignored.
- A turn that ends (`result`) or a session that stops also clears
  `compacting`. A compaction must never outlive its session.

`compacting` is in-memory only. It rides on `ApiSession` and is republished
on the `sessions` topic, the same way `contextUsedTokens` is, so the whole
map sees it and not only the open panel.

**Trigger.** The success path takes it from `compact_boundary`. A failure
reports no trigger, so Orbital records it itself: the compaction is
`manual` when the turn it runs in was started by a user message that is
the `/compact` command (with or without arguments), and `auto` otherwise.

### Success

This extends the existing `compact_boundary` handling (context-fill-arc
spec, which already updates `context_used_tokens`). The runner emits a
`compaction` transcript item carrying `trigger`, `preTokens`,
`postTokens | null`, `durationMs | null`, the timestamp and the summary text
(from the synthetic summary frame that follows). Today `sdkToChatMessages`
drops that frame, so it has to be read before it is dropped.

The transcript parser (the terminal path, and the reload path for Orbital
sessions) builds the same item from `compact_boundary` plus the
`isCompactSummary` entry. Both paths must produce the same shape, and the
parser is where that is tested.

### Failure

On `compact_result: 'failed'`, the server:

1. **Persists the failure** in a new table `compaction_failures`
   (`id`, `session_id`, `at`, `error` nullable, `pre_tokens` nullable,
   `trigger`, `duration_ms` nullable). The CLI does not write it into the
   transcript, so without this table the mark would disappear on reload.
   `pre_tokens` is the session's `context_used_tokens` at the moment the
   compaction started. On reload, failures are merged into the transcript at
   their timestamp.
2. **Writes an error log entry**: `source: 'server'`, new `ErrorKind`
   `'compaction_failed'`, with `sessionId`. `message` is `Compaction failed:
   <error>`, or `Compaction failed (no reason given)` when there is no text.
   `context` holds `trigger`, `preTokens`, `durationMs`, `model` and `cwd`.
   This way the failure also shows up in the error log, even when the
   session is not open.
3. Sets `lastCompactionFailed: { at } | null` on `ApiSession`. It stays set
   until a compaction succeeds or the session's next turn starts. Opening
   the session does **not** clear it, because opening does not fix the
   context. It survives a restart: derive it from the newest
   `compaction_failures` row versus the session's last turn start or last
   success.

### Dev simulation

Failures are rare, so the UI has to be testable without one. A dev-only
route, registered only when the server runs from `npm run dev` (use
whatever signal already tells dev from the bundled server; if none exists,
the root `dev:server` script sets `ORBITAL_DEV_TOOLS=1`):

```
POST /api/dev/sessions/:id/simulate-compaction
{ "outcome": "success" | "success_no_post_tokens" | "failed" | "failed_no_error",
  "seconds": 5 }
```

It feeds fake SDK messages (`status: compacting` → wait → boundary and
summary frame, or a failed status) into the **same handler** `pump()` uses.
It must not have a side path of its own. It does nothing to the real CLI
session and is never registered in the packaged app. A route test asserts
that it is absent without the dev signal.

## Web

### Planet (Orbital sessions only; canvas 26b, 26e)

While `compacting` is set, the planet's state is **compacting**. It has
priority over working and waiting, and it loses to needs-input (a
compaction does not ask anything of the user, so they cannot happen at once
anyway):

- The ticks stop, the core becomes a hollow ring in the tag hue and the
  context arc greys out (26e values). This takes 300 ms.
- Two grey rings contract inward, half a cycle apart. **Their phase is taken
  from `compacting.startedAt`**, so planets compacting at the same time
  never pulse in step.
- After 3 s the `COMPACTING m:ss` pill appears, counting up.
  It takes the place of the `/compact` badge, and needs-input still wins the
  pill slot.
- Moons keep their own state. Background subagents keep running during a
  compaction, so the planet's treatment must not dim or freeze its moons.

On success the arc drains to the new value in 700 ms and the caption
`compacted · 186k → 22k` shows for 6 s. The caption is plain `compacted`
when `postTokens` is null. On failure the arc and the core go back to how
they were, and the badge becomes `COMPACT FAILED · NN%` while
`lastCompactionFailed` is set. Clicking it opens the session scrolled to
the mark.

Terminal planets never show the compacting state or the caption: they have
no context arc, and their compaction is known only afterwards.

`ScenePlanet` gets the state and its start time from `buildSceneModel`. The
state derivation is a pure function and is unit-tested.

### Summary line and sidebar

- **Summary line:** a compacting session counts as **WORKING**. There is no
  separate `COMPACTING` segment.
- **Sidebar row:** `COMPACT m:ss` as the row's state label (26e).
- **Detail header:** the state label reads `COMPACTING m:ss`. The context
  gauge keeps the old number at reduced opacity and its note reads
  `COMPACTING…` (26c).

### Transcript while it runs (26c)

- A live `COMPACTING CONTEXT m:ss` block at the end of the transcript,
  with the line matching the trigger (`Manual: you ran /compact at 186k of
  200k.` or `Auto: the context reached 186k of 200k.`). Leave out the "of
  200k" part when the window is unknown.
- **The history above is not dimmed.**
- **The composer is locked.** The field is disabled, the placeholder reads
  `Compacting. You can write again when it's done.` and Send is inert.
  Clicking the `/compact` badge does nothing in this state.

### The permanent mark (26d)

The mark is a transcript item of its own. It is not a chat bubble and it
does not take part in tool-run folding.

- **Succeeded:** `CONTEXT COMPACTED`, a before → after bar with `−NN %`,
  and a meta line of trigger · duration · time. The explanatory line and a
  folded `▸ summary` that expands to the summary text follow. With
  `postTokens` null, show the figure before, with no bar and no percentage.
  `N OF M` is added to the heading once a session has more than one
  compaction.
- **Failed (Orbital sessions only):** `COMPACTION FAILED`, `NNk unchanged`
  (or no figure when `pre_tokens` is null), meta, the error quoted exactly
  (or `No reason given`), and the explanatory line. Two actions:
  - **Copy** copies the whole record as one block of text (session id,
    time, trigger, tokens, duration, error), in the error log's
    copy format.
  - **`/compact again`** puts `/compact` into the composer. It appears only
    on the newest failure mark and only while the session is live.
- **Terminal:** the same success mark, with `in terminal` added to the meta
  line. The duration is shown too, because terminal transcripts carry it.
- **Time:** time of day for today, an absolute date for anything older.

### Confirmation when subagents are running

When the user sends `/compact` from Orbital (the composer, the `/compact`
badge or `/compact again`) and the session has subagents that have not
ended, a dialog asks first:

> **Compact while 2 subagents are running?**
> They keep running and their results still come back. Claude will only
> remember a summary of why it started them.
> [Cancel] [Compact]

Automatic compaction cannot be confirmed, and nothing is shown for it. The
count uses the existing active-subagent count. The decision "does this send
need confirming" is a pure function and is unit-tested. The dialog follows
`StopDialog`'s structure and primitives. It is not on the canvas, so its
visual fidelity is checked by the main session afterwards.

## Deviations from the canvas

- **No planet resize.** The canvas shrinks the planet on success. The
  context-fill-arc scope cut stands (planet size does not follow context),
  so only the arc drains.
- **No `COMPACTING` segment in the summary line.** Compacting counts as
  working.
- **History is not dimmed** while compaction runs.
- **No summary token count** on the mark.
- **No terminal failure mark** (see above).
- **Terminal meta shows the duration** next to `in terminal`. The canvas
  assumed terminal transcripts have none, and they do.
- **Terminal planets play no shrink or caption.** They have no arc to
  drain.

## Testing

Worth testing, per the repo rule:

- runner: status handling (start, success end, failure end, `requesting`
  ignored, a turn end clears it), manual versus auto attribution for
  failures, the failure row and the error log entry, `lastCompactionFailed`
  set and cleared (by success, by the next turn, not by opening), and its
  derivation after a restart
- parser: the compaction item from a boundary plus summary, with and
  without `postTokens`/`durationMs`; the live and reload paths produce the
  same shape; failures merged at their timestamp
- dev route: absent without the dev signal; its outcomes go through the
  real handler
- web: the planet state derivation (priority over working, losing to
  needs-input, terminal never), the pill's 3 s rule, the confirm
  predicate, the `N OF M` index, and the composer lock (disabled while
  compacting)

Not tested: ring timings, colours, opacities. The canvas is checked by hand.

## Corrected in build

Where the build had to decide something this spec left open, or found it
could not do exactly what is written:

- **`lastCompactionFailed` is a stamp, not a comparison.** Nothing persisted
  "the session's last turn start", so the derivation after a restart could
  not compare against it. `compaction_failures` carries a `cleared_at`
  column instead: the next turn starting (a send, a revive's first prompt, a
  turn the CLI starts by itself) or a compaction succeeding stamps every
  open failure of the session. `lastCompactionFailed` is the newest row
  with no stamp. Same behaviour, one source of truth, survives a restart.
- **The success caption needs the numbers on the snapshot.** `ApiSession`
  gains `lastCompacted: { at, preTokens, postTokens } | null`, in memory in
  the runner like `compacting`. Nothing else says "a compaction just
  succeeded" to a map that is not subscribed to the session.
- **The live block drops "Usually under a minute."** The canvas copy says
  it; the real compactions this spec measured took 74–156 s.
- **`COMPACT FAILED · NN%` does not follow the `/compact` badge setting.**
  It needs the gauge (for the percentage), so the master context toggle
  still hides it, but a failure is not a suggestion to compact and is shown
  whether or not the `/compact` badge is switched on.
- **`N OF M` counts the rows the transcript holds.** An older page not yet
  fetched is not counted until it is.
- **A failure with no `pre_tokens`** reads `unchanged` with no figure.
- **Terminal marks read the summary only when the boundary and the summary
  arrive together.** The transcript tail converts each batch of appended
  lines on its own; a summary written in the next batch is dropped rather
  than shown as a user row, and the mark gains it on reload.
