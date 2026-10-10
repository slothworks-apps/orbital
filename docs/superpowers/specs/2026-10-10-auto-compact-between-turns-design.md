---
id: 2026-10-10-auto-compact-between-turns-design
title: Auto-compact between turns — Orbital compacts a quiet session past a token threshold
type: spec
status: active
domain: sessions
related:
  - context-fill-arc
  - 2026-09-28-context-compaction-design
  - an-orbital-tag-marks-a-walkthrough-turn
  - why-orbital
tags:
  - runner
  - compaction
  - settings
  - experimental
---
# Auto-compact between turns

## Why

Every request a session makes reads its whole context again. From the prompt
cache that costs a tenth of the input price, but on a 1M-context model a
session runs to several hundred thousand tokens before the CLI compacts it on
its own. At that size every tool call in every turn reads the full context.
When a quiet session's cache expires, or the session sleeps and is revived,
the next request writes the whole context to the cache again, at 1.25–2× the
input price.

Most of that context does not help the work. Orbital can keep it smaller by
compacting a session itself, but only at a moment that does not interrupt
anything: after a turn has ended, nothing is running, and the user has not
answered for a while.

### What it would have saved

A simulation over the owner's transcripts for 3–10 October 2026: 64
Orbital sessions, 8,365 main-loop requests, a median context of 266k
tokens, 90th percentile 530k. Only 8 compactions happened in that week.
Cost is weighted by price (cache read 0.1, cache write 1.25/2, output 5,
relative to input). Each simulated compaction pays for reading the context
once, writing a 21.7k summary (the median `postTokens` of real compactions)
and putting it back in the cache. Every later request in the session reads
correspondingly less.

| threshold | quiet 0 | quiet 2 min | quiet 10 min | quiet 30 min |
|---|---|---|---|---|
| 100k | −59 % | −57 % | −50 % | −32 % |
| 150k | −53 % | −51 % | −44 % | −28 % |
| 200k | −49 % | −47 % (39 compactions) | −41 % | −27 % |
| 300k | −37 % | −35 % | −32 % | −21 % |

The simulation does not count what a compaction makes the session re-read
(files it has to open again), so the real saving is lower. The defaults
(200k, 2 min) sit where the saving is still close to its ceiling and a
summary is not forced on short sessions.

The context-fill-arc spec left "auto-compact at T2" out of scope as an idea.
This is that idea, built on an absolute token threshold rather than a
percentage, because what it saves is tokens, whatever the window size.

## What it does

An experimental switch, off by default. While it is on, the runner sends
`/compact` into an Orbital session by itself when **all** of these hold:

1. The session is one this runner owns (`source: 'web'`). Terminal sessions
   are only shown, never driven (`why-orbital`).
2. Its status is `needs_input`: the turn has ended, no subagent or background
   task is running, and the CLI does not report `running`. A parked decision
   (a question or a permission ask), a usage-limit wait (`idle`) and
   `working` never qualify.
3. It has stayed `needs_input` for the **quiet delay** without interruption.
   Any move to `working` (a send, a harness step, a turn the CLI starts by
   itself) cancels the countdown. The next `needs_input` starts it again.
4. The last reading of `contextUsedTokens` is at or above the **threshold**.
5. No compaction is running.
6. Since the last turn the user or the harness sent, Orbital has not
   auto-compacted this session and no compaction in it has failed. This
   rules out a loop when the summary itself is still above the threshold,
   and a failed compaction is not retried behind the user's back. The
   user's own `/compact again` stays the way to retry. This is the same
   window in which `lastCompactionFailed` stands, kept in the runner
   (`autoCompactBlocked`) so it needs no database read.

The countdown is a timer next to the sleep timer and has the same lifetime.
`settleStatus` arms it when the session settles to `needs_input` and clears
it when the session moves away. `release` clears it too. When it fires, the
runner checks every condition again before it sends, because the timer can
outlive any of them.

The quiet delay is clamped below `SLEEP_AFTER_IDLE_MINUTES` (30 min). A
session that sleeps first stops its process, and Orbital does not wake a
sleeping session just to compact it.

### What it sends

The same path as the composer: `runner.send(sessionId, text)`. The text is
`/compact` with an Orbital tag as its argument:

```
/compact <orbital-auto-compact threshold="200000">Orbital is compacting between turns because the context passed the threshold the user set. Keep what the next turn needs to carry on with the current task.</orbital-auto-compact>
```

The CLI passes the argument to the summariser as its instructions, so the tag
has to read as a sensible instruction. It is also how the compaction is
recognised as Orbital's (see below), following the precedent of
[[an-orbital-tag-marks-a-walkthrough-turn]].

From here everything is the existing compaction machinery
(`2026-09-28-context-compaction-design`): the `compacting` state on the
planet, the locked composer, the permanent mark, the failure record and the
`compacted · 186k → 22k` caption. Nothing about it is new except the
trigger and the composer.

### The composer stays open

A compaction takes 1–2.5 minutes. One the user asked for locks the composer,
as before. One Orbital started does not: nobody should wait on something they
did not ask for. The field reads `Orbital is compacting. What you send goes
out when it's done.`, and a message sent then is queued into the CLI's input
behind the `/compact` and runs once the compaction ends. This holds on the
phone too (`composerLockedByCompaction` in `web/src/lib/compaction.ts`, read
by `DetailPanel` and `SessionComposer`).

A message sent into a turn that is already running does not become that
turn's prompt (`turnPrompt` in the runner), so the compaction it was queued
behind keeps its `orbital` trigger.

### The trigger: `orbital`

The compaction trigger becomes `'manual' | 'auto' | 'orbital'`:

- **Live:** `compactTriggerOf(turnPrompt)` returns `orbital` when the turn's
  prompt is `/compact` followed by the `<orbital-auto-compact` tag, `manual`
  for any other `/compact`, and `auto` otherwise. This one change covers
  `compacting.trigger`, the success mark and the failure row.
- **Reload and transcript:** the CLI records the boundary itself as
  `manual`. The parser upgrades a `manual` boundary to `orbital` when the
  `/compact` command entry before it carries the tag in its arguments.
  *To verify in build:* no manual compaction exists in the local
  transcripts, so the shape of that command entry has not been seen yet.
  If the arguments are not in the file, the reload shows `manual` and this
  section is corrected.
- **The tag folds as machinery**, like `<orbital-walkthrough>`: the parser
  adds it to `NOISE_BLOCK`, so a human never reads the instruction text as
  if they had typed it. Inside the CLI's `<command-args>` it is folded with
  them.
- **Copy:** the live block reads `Orbital: compacting between turns at 212k
  of 1M.` (`of …` only when the window is known), and the mark's meta line
  names the trigger `orbital`, as it names `manual` and `auto`. The `compaction_failures.trigger`
  column is plain text and takes the new value without a migration.

## Settings

The switch and its two values live in Settings → Experimental → FEATURES,
under the rows that are there today:

| key | default | UI |
|---|---|---|
| `auto_compact_enabled` | `'false'` | Toggle "Auto-compact between turns" |
| `auto_compact_threshold_tokens` | `'200000'` | Number in thousands (`200` → 200k), clamped to [50k, 900k] |
| `auto_compact_quiet_seconds` | `'120'` | Number of seconds, clamped to [0, 1500] |

The description reads: "Compacts an Orbital session by itself once it has
ended a turn, has been waiting for you for the quiet delay and its context is
above the threshold. Never in the middle of a turn. Saves tokens; the session
keeps only a summary of what came before."

The server reads all three through `settingsStore` each time the timer is
armed and again when it fires, so a change applies from the next quiet
period, with no restart. Garbage values fall back to the defaults. The
parsing is a pure function next to the runner and is unit-tested.

## The phone

The phone's composer follows the same rule as the desktop's: it stays open
during a compaction Orbital started. The phone gets no settings for this on purpose: Experimental is a desktop
section, and the switch belongs to the Mac that runs the sessions. Nothing
else is needed for the phone to show it. The compaction reaches the phone
through what it already uses: `compacting` and `lastCompacted` on the
`sessions` topic, and the mark in the session transcript. The phone's
composer lock (`SessionComposer.tsx`) already reads `compacting`. If the
phone renders the trigger anywhere, it gets the `orbital` copy along with
the web.

## Calm

Nothing new demands attention. A compaction Orbital starts looks like any
other on the map: the compacting state while it runs, and the short caption
afterwards. There is no notification and no sound, and a failure lands where
every compaction failure already lands. The session is not ended, stopped or
woken.

## Stats

The Stats page gets an **AUTO-COMPACT** panel under the cache hit ratio,
shown once Orbital has compacted something in the window. It answers
whether the experiment pays, from the transcripts, so it covers every
compaction ever made, including those from before the panel existed.

`computeCompactionStats` (`server/src/stats/compaction.ts`) reads one
session in a single pass and stores the result in `session_stats.compaction`
(JSON; `STATS_VERSION` 4 re-indexes every session once).
`autoCompactSummary` (`server/src/stats/window.ts`) adds up the window and
prices it at each session's own model when the page is read.

- **Compactions:** how many Orbital started, the average context before and
  after, the average duration, and how many others (the CLI's, the user's)
  happened beside them.
- **Saving (an estimate):** compared with the same session without Orbital's
  compactions. After each one, every later main-loop request would have
  carried the tokens it removed: as a cache read when the request read the
  cache, and as a cache write when the cache had gone cold. That lasts until
  a compaction Orbital did not start, which would have happened anyway. From
  that comes the cost of the compactions: reading the context once, writing
  the summary, and writing the summary to the cache where the request after
  would otherwise have read. The headline is the net, in dollars and as a
  share of what those sessions would have cost without it.
- **Re-read after:** `Read` calls in the turn after an Orbital compaction
  (up to the second human prompt after it) of a file read before it, once
  per file. It shows whether the summary dropped something the session
  needed.
- **Orbital sessions with and without it:** cost per turn and context per
  request, measured. The two groups are not like for like (long sessions are
  the ones that get compacted), so this sits under the estimate as a check,
  not as the answer.

The phone has no Stats page, so this does not reach it.

## Not in scope

- **Compacting before the user's next message.** A session that is answered
  within the quiet delay keeps growing until the CLI compacts it. Holding a
  typed message back until a compaction finishes could catch that case
  too. Revisit if the quiet-delay policy does not save enough.
- **Terminal sessions.** For those, lowering the CLI's own auto-compact
  threshold (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json`)
  is the lever. That is user configuration, not Orbital's.
- **A per-session override.** The switch is global while it is
  experimental.

## Testing

- The decision "should this session be auto-compacted now", as a pure
  function of status, decision, reading, threshold, compacting, failure and
  the already-compacted flag: every condition alone blocks it.
- Runner: the timer is armed on settling to `needs_input`, cleared on
  `working` and on release; when it fires it checks again and sends the
  tagged `/compact` once; there is no second auto-compact before a
  user-started turn.
- `compactTriggerOf`: `orbital` for the tag, `manual` for a plain
  `/compact` or `/compact` with other arguments.
- Parser: a `manual` boundary after a tagged command reads `orbital`, and
  the tag folds as machinery.
- Settings parsing: defaults, clamping, garbage.

Not tested: the settings rows and the copy.
