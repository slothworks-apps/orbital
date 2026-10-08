---
id: a-revoke-can-slip-between-the-relays-store-read-and-attach
title: A revoke can slip between the relay's store read and attach
type: fix
status: done
domain: remote
related:
  - 2026-10-02-mobile-app-read
  - 2026-09-30-mobile-remote-design
tags:
  - relay
  - mobile
---
# A revoke can slip between the relay's store read and attach

Found while building Task 14 of [[2026-10-02-mobile-app-read]] (the relay
telling a phone `unpaired` on its next connect after being revoked while
away).

## What happens

`relay/src/ws.ts`'s connect handler reads a device's `peers` once, before
the socket is attached:

```ts
const peers = new Set(await ctx.store.peersOf(pub));
await ctx.store.touch(pub, ctx.now());
if (socket.readyState !== socket.OPEN) return;
socket.off('message', hold);
attach({ socket, id: pub, peers }, ctx, early, expectMac);
```

`attach` runs after an `await`, and only then calls `ctx.connections.add(conn)`
— the point at which this device is reachable by id. If a `/pair/revoke`
request lands in the gap between `peersOf` and `attach` (anywhere across
the `touch` await, or during `attach`'s own setup before `add`), the pair
row is deleted before this connection is registered. The `unpaired`
control the revoke path sends goes nowhere useful: the phone's old socket
is the one about to be terminated or already gone, and this new connection
is not yet in `ctx.connections` to receive it. `attach` then sends `ok`
built from the stale `peers` it already captured — the just-revoked Mac is
still in it — and no `unpaired` follows, because `expectMac !== null &&
!peers.has(expectMac)` is false against the stale set.

## Why it is not fixed now

Since Task 14, the phone always connects with `paired=1` when it has a
stored pairing, so a phone caught by this race simply reads as paired for
one more connection and is told `unpaired` on the next one — the gap is a
narrow window inside a single connect, not a permanent miss. 2a's goal was
the connect-time check; closing this race was out of scope for that task.

## What to try

Re-check the pair after the device becomes reachable, not before: read
`peers` after `ctx.connections.add(conn)` in `attach` (or re-check
`expectMac` membership against a fresh `peersOf` call at that point) so a
revoke that lands during the handshake is observed instead of raced.

## Fixed 2026-10-08

Worse than described above: the stale `peers` also let the revoked phone's
frames through to the Mac for the whole connection, since `route` checks
that same set. `Connections` now carries a pair generation that
`/pair/confirm` and `/pair/revoke` bump in the step that edits the live
`peers`; the connect handler repeats its `peersOf` read until no pair
changed across it, and nothing awaits between that check and `attach`
registering the device. A pair confirmed during the gap is picked up the
same way. Covered in `relay/test/ws.test.ts`.
