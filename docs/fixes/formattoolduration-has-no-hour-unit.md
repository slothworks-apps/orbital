---
id: formattoolduration-has-no-hour-unit
title: formatToolDuration has no hour unit, so a long agent run reads "120m 3s"
status: backlog
type: fix
domain: transcript
related:
  - 2026-09-22-subagent-transcript-panel-design
  - folded-tool-run-duration-needs-every-item-timed
tags:
  - web
  - transcript
  - subagents
---

# `formatToolDuration` has no hour unit, so a long agent run reads "120m 3s"

Found by the whole-branch review of `feat/subagent-panel`. Filed rather than
fixed: the fix needs a format the canvas does not draw, on a reading the
design never showed at that scale.

## What the bug is

`formatToolDuration` (`web/src/lib/format.ts`) has three bands and stops:

```ts
if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`   // 0.3s
if (ms < 60_000) return `${Math.round(ms / 1000)}s`    // 42s
const totalSeconds = Math.round(ms / 1000)
return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`   // 1m 4s … and 120m 3s
```

It was written for TOOL CALLS, where minutes are already the long tail and
the top band never has to carry much (canvas 11b quotes `0.3s`, `42s`,
`1m 4s`). This branch then reused it for the subagent panel's **elapsed
header** — the headline number for a thing you are watching run, which ticks
for as long as the agent does — and for a folded run's summed duration.
An agent that runs two hours reads `120m 3s`; overnight, `487m 12s`.

`formatDuration` in the same file does carry minutes/hours/days, which is
why `formatToolDuration` exists separately: `formatDuration` bottoms out at
`1m` and would render every sub-minute tool call identically. Neither
function covers the whole range this branch now asks for.

## Why it is not fixed here

The missing band needs a form, and no canvas draws one. `2h 0m`? `2h 0m 3s`?
Does the seconds field survive past an hour at all — a per-second tick is
the point of the header while a run is short, and noise once it is long? The
existing two-unit shape (`1m 4s`) suggests `2h 0m`, but that is an inference
from one example, not a design.

It is also not purely cosmetic in the panel: the elapsed reading is the one
number that animates, and its width changing band would move the header's
layout.

## Where to start

`formatToolDuration` and `web/src/test/format.ts`. Ask the canvas
(`Feature - Subagent panel.dc.html`, 11b/11c) for a long-run header before
picking a form; if it does not draw one, that is the design question to put
to Tomin rather than to answer in code.
