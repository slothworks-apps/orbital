---
id: a-rule-names-its-turn-by-uuid
title: A rule names its turn by uuid, and the jump stays on /stats
type: adr
status: in-force
domain: stats
related:
  - 2026-09-20-session-stats-design
---

# A rule names its turn by uuid, and the jump stays on /stats

Canvas 10e says a click on a finding "opens `/stats/session/<id>` scrolled to
the waterfall, offending turn pre-highlighted", and 10b draws a `jump to turn
12 ›` link on every finding card of the drilldown. Both need one thing the
data did not provide: a key that a rule's evidence and a lane of the waterfall
agree on.

The rules record the transcript entry uuid of the turn they blame —
`firstTurnUuid` for `cache-burn` and `error-loop`, `turnUuid` for
`obese-tool-result`. The turn segments the drilldown draws carried
`requestId`, which is a different identifier of the same turn, and the two
could not be matched.

## The decision

**`TurnSegment` carries the uuid of the entry that opened the turn**
(`server/src/stats/compute.ts`), and `/api/stats/sessions/:id` returns it with
every lane. A finding is resolved to a lane by that uuid, in one place
(`findingTurnUuid` in `web/src/stats/findingCopy.ts`), and the drilldown turns
the lane's position into the `T12` the canvas prints.

The alternatives were both worse than a field:

- **Re-derive the turn in the browser.** `cache-burn`'s first affected turn is
  the first one under a hit-ratio threshold that lives in the server's
  constants. Mirroring the threshold into the web bundle would put two copies
  of a tunable number one release apart, and a card that highlighted a
  different turn than the one it was measured on would be worse than no
  highlight.
- **Match on the tool name.** Works for `error-loop` and `obese-tool-result`
  by accident (the first failing call of that tool is usually the right one),
  nothing for `cache-burn`, and it is a guess dressed as a fact.

The uuid also travels in the URL — `?turn=<uuid>`, `TURN_PARAM` in
`web/src/stats/route.ts` — so the highlight survives a reload and a card on
the dashboard can link straight at it. A uuid the transcript no longer holds
(re-read after a compaction, say) resolves to nothing and the card offers no
jump, rather than pointing at whatever lane happens to be first.

## The jump does not leave /stats

10e's behaviour table also has a row saying that clicking "jump to turn N"
opens the session's transcript in the map detail panel and leaves `/stats`.
The drilldown does not do that: the link scrolls its own waterfall to the lane
and highlights it (controller ruling, task 6 brief).

That row was written for a card in the dashboard feed, where there is no
waterfall to scroll to. On the drilldown the waterfall is the thing on screen,
and throwing the reader onto the map — a different page, a different mental
model, a WebSocket and a full session load — to see a turn they are already
looking at is a navigation nobody asked for. The page keeps one way off it,
`open transcript` in the header, which is explicit about leaving.
