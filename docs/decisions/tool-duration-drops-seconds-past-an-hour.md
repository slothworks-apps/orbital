---
id: tool-duration-drops-seconds-past-an-hour
title: formatToolDuration reads "2h 14m" past an hour, dropping seconds
type: adr
status: in-force
domain: transcript
related:
  - formattoolduration-has-no-hour-unit
  - 2026-09-24-backlog-sweep
tags:
  - web
  - transcript
  - subagents
---

# `formatToolDuration` reads "2h 14m" past an hour, dropping seconds

## The problem

[[formattoolduration-has-no-hour-unit]] found that `formatToolDuration`
(`web/src/lib/format.ts`) had no band past a minute: `1m 4s`, `120m 3s`,
`487m 12s`. The function was written for tool calls, where minutes were
already the long tail, then reused for the subagent panel's elapsed header
and a folded run's summed duration — both of which can run for hours. The
fix doc filed the bug rather than fixing it: the missing band needs a form,
and no canvas draws a duration at that scale (`Feature - Subagent panel.dc.html`
11b/11c stop at `1m 4s`).

The choices were: keep seconds past an hour (`2h 0m 3s`), drop them
(`2h 0m`), or drop minutes too and read something like `2h`.

## What was decided

Past an hour, `formatToolDuration` reads two units — `2h 0m`, `2h 14m`,
`8h 7m` — and drops seconds. Below an hour nothing changes: `0.3s`, `42s`,
`1m 4s` are untouched.

This mirrors `formatDuration` in the same file, which already drops seconds
once it has a bigger unit to spend (it bottoms out at `1m`, never `61s`).
`formatToolDuration` existed separately from `formatDuration` precisely
because sub-minute tool calls need a decimal `formatDuration` never renders;
extending that same "drop the finer unit once a coarser one exists" rule to
the hour boundary keeps the two functions reading as one system rather than
inventing a third rounding rule.

The elapsed header ticks per second while a run is short — that's the
existing behaviour, unchanged, since it stays below the hour band the whole
time it visibly matters. Once a run has gone on for an hour, a per-second
digit is noise, not information: nobody reads "2h 14m 37s" and gets more out
of it than "2h 14m" gives them, and the trailing field would otherwise
gain and lose a digit every ten seconds, jittering the header's width for no
reason.

## What was rejected

**Keeping seconds past an hour (`2h 0m 3s`).** Three units for something
nobody reads at second resolution once it is already hours long — it is
the reading `formatDuration` avoids everywhere else in the file.

**Collapsing to a single unit past an hour (`2h`).** Loses too much: `2h`
and `2h 59m` would render identically, which is worse for a running total
than the two-second-per-minute jitter this decision accepts giving up.

## Consequences

- `formatToolDuration`'s hour band is computed from rounded whole minutes
  (`Math.round(ms / MINUTE_MS)`), not from the same `totalSeconds` the
  under-an-hour bands use — consistent with dropping the finer unit rather
  than truncating it away.
- The elapsed header's width changes bands going into and out of the hour
  mark, as flagged in the fix doc as a real (if minor) layout consequence;
  nothing here changes that observation, it is just no longer blocking.
- Tested at `web/src/test/format.test.ts`: `59m 59s` unchanged, `60m` becomes
  `1h 0m`, and the fix doc's own `487m 12s` example becomes `8h 7m`.
