---
id: leaderboard-bars-are-max-normalised
title: Leaderboard bars are max-normalised, the label is the honest share
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
---

# Leaderboard bars are max-normalised, the label is the honest share

The tool leaderboard on `/stats` (canvas 10a) has a column headed SHARE OF
TOOL TIME holding a bar. Two readings of that column were possible and they
produce very different panels.

Drawn as an honest share — a tool's milliseconds over every millisecond the
window spent inside a tool — the bars collapse. A busy week spreads its tool
time over dozens of tools, so on the canvas's own numbers the top row tops out
around 11% of the track and everything below it is a stub: the ranking the
panel exists to show stops being legible at exactly the moment there is enough
data to rank.

The canvas does not draw it that way. 10a's widths (74 / 61 / 38 / 22) are
proportional to the durations next to them, with the leading row at 74% of the
track — max-normalised geometry.

## The decision (controller Ruling 15)

Split the two jobs across two elements:

- **The bar is normalised to the leading row.** It answers "how do these tools
  compare", which is what a ranked list is for, and it keeps the canvas's
  geometry.
- **The label next to it is the honest share** of the window's tool time —
  `ms ÷ (localToolMs + mcpMs + subagentMs)`, the subagent lane included
  because an `Agent`/`Task` call is a tool call and a share must not exclude
  part of its own total.

The SHARE OF TOOL TIME heading names the label, not the length of the bar.
`web/src/stats/leaderboard.ts` returns both numbers per row and is the only
place either is computed; `statsleaderboard.test.ts` pins the split.

The alternative — one honest bar and no label — was rejected for the stub
problem above. The reverse, a normalised bar with no label, was rejected
because then nothing on the panel says whether the leading tool is a tenth of
the window or half of it, which is the actionable part.

## The "most expensive" tab is part of this decision

The canvas draws the `slowest` tab only. The second tab reuses the same
columns against the endpoint's `mostExpensive` ranking: the bar is normalised
the same way, TOTAL prints estimated tokens (`resultChars ÷ CHARS_PER_TOKEN`),
and the heading changes to SHARE OF RESULT TOKENS.

That share has a weaker denominator than the slowest tab's: the rollup keeps
`resultChars` per tool but the endpoint returns only the top of the ranking,
so there is no window-wide character total to divide by and the share is of
the listed rows' own volume. The changed heading is what keeps it honest. If
the overview ever returns a window-wide result-volume total, divide by that
instead and delete this paragraph.

## Display cap (controller Ruling 16)

The endpoint ranks ten tools per tab; the canvas panel is four rows tall.
Showing all ten made the panel about two and a half times its drawn height and
pushed the rest of the left column off a 900px screen. The panel now caps its
height at four rows and scrolls, under the same measured fade the findings
feed uses — the rows are capped visually, never sliced, so every ranked tool
is still reachable.
