---
id: 2026-09-30-harness-lucky-and-step-records-design
title: Harness — feeling lucky (a reviewer decides the gates), step records, and caps you can set
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-session-harness-design
  - 2026-09-30-assisted-harness-templates-design
  - 2026-09-29-rewind-design
tags:
  - harness
  - experimental
---
# Harness — feeling lucky, step records, and caps you can set

Builds on [[2026-09-30-session-harness-design]]. For long and overnight runs
a harness should not wait hours on a gate; and what it did while nobody
watched must be readable — and undoable — in the morning.

## Options

A template carries `options`, copied into the session's harness and
editable there:

| option | default | with lucky |
|---|---|---|
| `commitPerStep` | on | — |
| `maxAutoRounds` | 150 | unlimited |
| `maxIdleNudges` | 5 | 5 |
| `maxReviewerReopens` (per step) | 5 | — |
| `lucky` | off | — |

The idle-nudge cap stays with lucky on: an agent stuck five times on one step
is stuck, and nudging it on burns tokens. What never loosens: pushing,
merging and opening PRs are no step's work.

## Commit per step

With `commitPerStep`, the kickoff and every step's instructions ask the agent
to commit its work locally (never push) before ticking, and
`harness_complete_step` refuses while the working tree is dirty. Outside a
git repository the option does nothing. It is what makes one step's changes
a clean `start..end` range.

A run nobody watches must not stop on a permission card for what the harness
itself asks for. So, while a session has a harness, Orbital allows without a
card: a step's own `verify` command, exactly as written, and — with
commit-per-step on — `git add` / `git commit` alone or joined by `&&` (never
a push, `--amend` or `--no-verify`, never chained with anything else). Found
in the end-to-end run: both stopped an unattended `acceptEdits` session on a
card. Any other command the agent needs still asks as the session's
permission mode says.

## The step record

What `harness_complete_step` takes: `summary` (what was done), `decisions`
(`{ what, why, alternatives? }[]`) and `open_questions` (what a person
should still look at). `evidence` is gone; `summary` replaces it.

What Orbital records on its own, per step, in the step state:
`startedAt`, `startHead` (git HEAD when the step became active), `endHead`
(at the tick), `startMessageUuid` (the user message Orbital sent to begin
the step — a rewind target), `nudges`, `approvedBy` (`user` | `reviewer`),
and the reviewer's `reviews`.

`GET /api/sessions/:id/harness/steps/:index/diff` → `{ range, stat, patch }`
for `startHead..endHead` (the patch capped at 200 KB), 409 without both heads.

## Feeling lucky: the reviewer

With `lucky` on, a step reaching `awaiting_approval` is reviewed instead of
waiting. The reviewer is an agent run through the SDK in the session's
directory, **read-only** (plan mode: it reads, greps, diffs and runs checks,
it writes nothing), on Opus, with no transcript and no planet. It gets the
template's purpose, the step's instructions, done criteria and record, and
the `git diff` of the step, and ends with a JSON verdict:

```json
{ "verdict": "approve" | "reopen", "uncertain": false,
  "reasoning": "…", "checked": ["…"], "findings": ["…"] }
```

- **approve** — the step is `done`, `approvedBy: reviewer`, and the next step
  is sent.
- **reopen** — the step goes back to `active` and the agent gets the
  findings as a message. After `maxReviewerReopens` reopens of one step it
  waits for the user.
- **uncertain** — the verdict is followed anyway, and the review is marked
  uncertain in the record for the morning.
- A failed or unparseable review pauses the harness with the reason and
  leaves the gate to the user.

Read-only is held twice. Plan mode is the first line: in the live check
(2026-09-30) the CLI let `Read`, `git log` and `ls` through on its own and
never reached the permission callback. The callback is the second: it allows
the reading tools and an allowlist of read-only commands (git's reading
subcommands, `cat`/`ls`/`rg`, the project's test, lint and typecheck
scripts), and refuses anything chained, redirected or substituted. In that
check the reviewer took 23 s, reopened a planted bug (a `divide` without its
required zero check) with the file and the fix, called out the agent's
inaccurate record, and left the repository untouched.

The review runs in the background (minutes). The harness is re-read after it:
a user who approved, reopened, paused or removed it meanwhile wins.

## In the panel

- A **Feeling lucky** switch beside auto-continue.
- A step expands to its record: summary, decisions, open questions, every
  review with its reasoning, checks and findings, the git range.
- **Show diff** opens the step's diff. **Go back here** rewinds the
  conversation to the message that began the step (the existing rewind) and
  reopens the checklist from that step; files are left alone — with commit
  per step, `git reset --hard <startHead>` is shown to copy.
- The template editor gets the options.

A "show in transcript" jump is left out: the transcript pages older history
in on scroll and cannot yet scroll to an arbitrary message.

## Testing

- Caps from options, and lucky's unlimited rounds, in `decideTurnEnd`.
- The review decision: approve, reopen, the reopen cap, uncertain, failure.
- The reviewer's reply parsing.
- `harness_complete_step` with a dirty tree under `commitPerStep`.
- The diff route.
