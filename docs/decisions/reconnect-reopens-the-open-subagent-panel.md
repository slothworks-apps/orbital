---
id: reconnect-reopens-the-open-subagent-panel
title: A reconnect re-opens the subagent panel rather than trusting the resumed subscription
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - subagent-messages-404-vs-empty-200
  - the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with
tags:
  - web
  - subagents
  - store
  - websocket
---

# A reconnect re-opens the subagent panel rather than trusting the resumed subscription

## The problem

`resyncAfterReconnect` rebuilds the selected session's transcript from REST,
because the WS replays nothing that happened while the socket was down. It
did not touch `subagentPanel`.

`OrbitalSocket.onopen` re-subscribes every topic it still holds a handler
for, `subagent:<sessionId>:<toolUseId>` included. So the subscription comes
back on its own — and that is exactly what made the gap invisible:

**(a) A dropped socket holes the transcript.** The client reattaches and
resumes appending. Every message published during the outage is in the
server's ring buffer, was never refetched, and is never republished. The
panel shows a transcript with a silent hole in the middle of it, which is
what spec § 10 exists to forbid: the reader must never be shown an
incomplete record that looks complete.

**(b) A server restart never reaches STREAM LOST.** Both server stores are
in memory and die together. `loadInitial()` repopulates `sessions` with
`subagents: []`; `ui.selectedId` is unchanged, so the close guard that
watches it does not fire. The panel kept its pre-restart messages, `found`
stayed `true`, the badge stayed RUNNING and the clock kept counting — a
stale transcript presented as live. And with `subagents` empty there was no
moon and no `OPEN →` row left to open a fresh panel from, so the 404 branch
was never taken either.

Net: `StreamLostBody`, `taskStateFor`'s `'stream_lost'` and all of § 10's
STREAM LOST design were dead code in the one scenario they exist for. The
only live path to `found: false` was the `!toolUseId` short-circuit in
`openSubagent`, which by construction never has a moon to click.

## What was decided

`resyncAfterReconnect`, after it has rebuilt `sessions` and the session
transcript, re-runs the open action:

```ts
const panel = get().subagentPanel
if (panel) await get().openSubagent(panel.sessionId, panel.subagent)
```

`openSubagent` rather than a bare refetch, because it is the one path that
does all four things this needs at once: it releases and re-takes the
subscription, it rebuilds the message list from the buffer, it re-reads
`droppedCount`, and — on a 404 — it writes `found: false`, which is what
finally makes STREAM LOST reachable. With the panel's agent now read live
([[the-panel-reads-its-agent-live-not-the-snapshot-it-opened-with]]) the
same pass refreshes the badge.

## What was rejected

**Fetching before swapping, the way the session transcript above it does.**
That helper exists so the open transcript never flashes empty. Rejected
here: it would mean duplicating `openSubagent`'s fetch/merge/404 logic at a
second call site, and the flash costs one request on a panel that is already
showing a transcript known to be incomplete. Stated as an accepted cost in
the code comment rather than left for a reader to discover.

**Merging the refetched buffer into the messages already held, instead of
replacing.** The same reasoning `resyncAfterReconnect` already applies to
session transcripts and records there: `select`'s merge PREPENDS what it has
not seen, which is the wrong end for a tail missed during an outage. A list
rebuilt from the buffer cannot be mis-ordered.

**Asking the server to replay a topic on re-subscribe.** A real fix to the
general problem and out of scope for this one: the hub has no per-topic
cursor, and the session transcript's own resync already establishes
"refetch from REST" as this codebase's answer to a WS gap.

## Consequences

- Every reconnect costs one extra request while a panel is open. Bounded,
  and only when a panel is open.
- The panel blanks for the duration of that request. Deliberate; see above.
- STREAM LOST is now reachable by the scenario it was designed for, and
  `web/src/test/subagentstore.test.ts` covers both halves — a reconnect
  refetches the open panel, and a reconnect after the server has forgotten
  the agent lands on `found: false`.
- `applySessionsEvent`'s `remove` branch closes the panel outright, which is
  the other half of "the parent went away" — see
  [[subagent-panel-close-watches-selectedid]].
