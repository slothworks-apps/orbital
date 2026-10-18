---
id: device-channel
title: The device channel — one socket, one channel, both halves
type: domain
status: in-force
domain: remote
related:
  - 2026-10-16-device-group-design
  - a-device-has-one-identity-and-one-channel-per-pair
  - device-group
tags:
  - remote
  - relay
---
# The device channel

How one paired device talks to another today: who opens the channel,
what the handshake carries, how an ask is told apart from an answer, and
where each piece of it lives in the code. This is part 1 of the device
group work (spec `2026-10-16-device-group-design` § 5); the roster,
mutual pairing and the allowlist it still runs against are later parts.

## One socket, one channel

Every device holds one relay socket and, per paired peer, one `Channel`
(`shared/src/remote/channel.ts`). The channel carries the handshake, the
cipher and both directions of traffic; the relay only moves sealed
frames between two keys and never sees what is inside them.

A `Channel` is constructed with a `role`, `initiator` or `responder`. The
role decides who sends the first handshake half and who only answers,
and it decides the numbering of ask ids (below). Nothing else about the
two roles differs: the same class carries both an asking half and,
when the device serves anything, a serving half (`ChannelServer`).

### Who initiates

`initiates()` in `shared/src/remote/device.ts` is the rule, checked
before either side opens anything:

- A phone always initiates.
- A peer whose kind is `null` — paired through an older Mac's code, from
  before devices named a kind — is initiated towards: that peer only
  ever answers.
- Otherwise, the side with the lower device id initiates.

A responder never refuses a handshake it did not expect: whichever side
answers accepts any valid one that arrives while it has no channel for
that peer. On the server (`RemoteService`, `server/src/remote/service.ts`)
this falls out of `open()` and `onData()`: `open()` calls `initiates()`
and starts a channel only when this side is the initiator; a frame that
arrives from a device with no channel yet builds one as a responder,
whatever this side's own id comparison would have said. A closed channel
is dropped from the map it is kept in (`RemoteService.channels`), so the
next frame from that device — the peer's retry, or a fresh handshake
after the old one went silent — builds a new one rather than being
refused by a half-dead entry.

That is the no-channel case. A live channel — one that already holds a
cipher — meets an unexpected handshake differently, in
`Channel.rehandshake()` (`shared/src/remote/channel.ts`): a frame the
current cipher cannot open, but the size of a handshake half, means the
initiator dropped the old session and started over on a new socket
(the responder kept the channel across that). `rehandshake` completes
that half as a fresh responder handshake, which only succeeds if it
verifies against the peer's known identity — so nobody but that peer
can reset the channel this way. Only once it verifies does the old
keys and everything tied to them get reset and the new cipher take
their place; a handshake that does not verify changes nothing.

## The handshake and `hello`

`Channel.start()` (initiator only) sends the first handshake half and
retries it on a timer until the responder's half completes it
(`HANDSHAKE_TIMEOUT_MS`). Once a side holds a cipher, it sends its own
`hello` — the initiator first, since it is the one that just finished
the handshake; the responder answers with its own `hello` once it
accepts the peer's.

Keys are not yet a channel. The initiator re-arms the same timer once
its keys are set, and if the peer's `hello` has not arrived when it
fires, it starts over with a fresh handshake: a peer that kept the keys
but never greeted (its hello lost, or a refusal sent before it had keys)
would otherwise leave the initiator keyed and never ready. The timer
goes with the peer's `hello`, with a `bye`, and with `close`. `keyed`
says whether a channel holds keys, ready or not; the phone's
`RemoteClient.beginHandshake` uses it when the Mac comes back online — a
channel still waiting for the handshake reply is left to retry, one
with keys (ready or not) is stale and replaced.

`HelloMessage` (`shared/src/remote/messages.ts`) is the same shape both
ways: `protocol`, and then whatever the sender is willing to say about
itself — `app`, `version`, `kind`, `os`, `name`, `capabilities` — plus,
only from a device that serves something, `server` and `macName`. `kind`
and `capabilities` are read as plain strings, not a closed enum: a device
from a later release may name a kind or a capability this one does not
know, and that must not fail parsing.

Parsing a hello is forgiving: only `t` and `protocol` can refuse it,
since a refused hello leaves the peer unreachable. `name` and `macName`
are cut to `PAIR_NAME_MAX_CHARS`, `kind` and `os` to
`HELLO_KIND_MAX_CHARS`; a `capabilities` list is cut to
`HELLO_CAPABILITIES_MAX`, and a capability longer than
`HELLO_CAPABILITY_MAX_CHARS` (or not a string) is dropped from it; a
field of the wrong type is read as absent and leaves no key. A shipped
device's hello parses exactly as before. What this side sends and keeps
stays inside the same bounds: `serverHello`
(`server/src/remote/identity.ts`) cuts the Mac's name, and
`RemoteService.join` cuts the name a pairing code carries before keeping
it.

Two fields are required in practice, by the oldest apps still in use,
even though the schema itself leaves everything but `t` and `protocol`
optional:

- A shipped phone requires `server` and `macName` from whatever serves
  it — it has always read a Mac's hello that way, and still does.
- Every hello requires `app` from whatever a shipped Mac judges — the
  Mac's `judgeHello` (`server/src/remote/deviceChannel.ts`) reads a
  phone's version out of `app` when it judges the hello at all (below).

`PROTOCOL_VERSION` is unchanged by this work.

### What a responder checks

The protocol check and the `judge` callback both run only on the
responder side, once, against the peer's first `hello` — an initiator
never reads the peer's `protocol` at all, and a channel to a peer this
side initiated towards is never judged. A responder whose peer's
`hello` names a different `PROTOCOL_VERSION` closes the channel with
`bye` `protocol` before `judge` even runs. In practice this is a
shipped Mac answering a phone, since a phone always initiates (above):
the Mac is the side that enforces the protocol version and judges the
version in `app`.

`openDeviceChannel` (`server/src/remote/deviceChannel.ts`) wires
`judgeHello`: a hello whose `kind` is `phone` (or absent, from an old
phone) is checked against `MIN_PHONE_VERSION`; anything else — another
Mac, a headless server — is not judged here at all, since its own
version is the group's concern, not this channel's. Within that check,
an `app` `judgeHello` cannot parse a version out of is treated the same
as a version new enough: not judged, no refusal — only a version it
*can* parse and read as too low is refused, closed with `bye`
`app_too_old` and the version it needs, or with `protocol` if it
predates knowing that reason (`PHONE_KNOWS_APP_TOO_OLD`) and would
otherwise drop the `bye` as unreadable.

## Ask ids and the two ranges

Both sides can ask and both can serve, over the same channel. An ask
carries an id the asker picked; the id ranges of the two roles never
overlap, so a blob chunk's id alone says whether it answers this side's
own outstanding ask or carries the peer's upload. The initiator numbers
from 1; the responder starts at `RESPONDER_FIRST_ID` (`shared/src/remote
/device.ts`), high enough that the two ranges cannot meet inside the
32-bit field a chunk's id travels in.

## The serving half

A device that serves anything plugs in a `ChannelServer`
(`open`/`ask`/`chunk`/`reset`). On the server this is `ServingHalf`
(`server/src/remote/servingHalf.ts`): `open()` gives it a `ChannelReply`
to answer through and builds a virtual socket the hub treats like any
other client, so hub topics, subscriptions and heartbeats all flow
through it unchanged. `ask()` dispatches by the ask's `t`: `ws`
(subscribe/unsubscribe, checked against `phoneMayWatch`'s allowed
topics), `http` (through `inject()`, behind the route allowlist,
`server/src/remote/allowlist.ts`), `blob_get`/`file_get` (an image from
the image store or a file a session may show, both chunked back through
`reply.inner`), `blob_put` (an upload, buffered until its last chunk),
and the notifications and `seen` asks. `reset()` is called whenever the
channel's keys end or the channel closes: it drops the virtual socket
(so the hub forgets this device's subscriptions) and clears any upload
in progress; the peer re-subscribes once its next `hello` lands.

A device that serves nothing (the phone) has no `serve` option on its
`Channel`; a peer's asks are simply never answered and time out there —
the phone's own `ChannelServer` answering a request with 404 belongs to
a later part, once federation runs over this channel.

## Watchdog and silence

Only the side whose peer serves runs the silence watchdog
(`TUNNEL_SILENCE_TIMEOUT_MS`, armed in `Channel.onHello`). Between two
servers, where each side serves the other, both run it — but the hub's
own heartbeat to every handled socket (including the virtual one
`ServingHalf` builds) keeps feeding it, so an otherwise idle channel
between two servers stays up: the heartbeat is traffic as far as the
watchdog is concerned, same as any other hub frame. A `silent` event
tells the caller to drop the link the channel rides on — `RemoteService`
closes the channel and, if it was the initiator, opens a fresh one.

A `bye` from the peer ends the keys inside the channel; on the server,
`RemoteService` then closes the channel too, so it leaves the map and
the peer's next handshake (or the next `presence`) builds a fresh one.
A frame the channel cannot send is dropped, and reported through
`onSendError`; the server logs it, naming the device.

## Where each piece lives

| piece | file |
|---|---|
| the channel itself: handshake, hello, asks, replies, the watchdog | `shared/src/remote/channel.ts` |
| device kind, capabilities, `initiates()`, `RESPONDER_FIRST_ID` | `shared/src/remote/device.ts` |
| `HelloMessage`, `AskMessage`, `AnswerMessage`, `parseChannelMessage`, `peerServes` | `shared/src/remote/messages.ts` |
| the server's serving half: hub, allowlist, blobs, files, notifications | `server/src/remote/servingHalf.ts` |
| the server's `Channel` wiring and phone version judging | `server/src/remote/deviceChannel.ts` |
| who opens a channel to whom, and the map of open channels | `server/src/remote/service.ts` (`RemoteService.open`, `.makeChannel`, `.onControl`) |
| the phone's side: one relay link, one channel to one Mac | `shared/src/remote/client.ts` (`RemoteClient.beginHandshake`) |

The phone still keeps one channel, to one Mac, in this part; a socket
carrying several channels — one per group member — is part 3 of the
device group work.

## The `group` capability and group messages

Part 2a (`docs/domains/device-group.md`) adds one capability, `group`:
a device names it in its `hello` when it keeps a roster and links with
other members — a Mac or a headless server. The phone's capabilities
stay `[]` here, so it never names `group`.

A channel carries three group messages — `roster_digest`, `roster`,
`removed` (`GroupMessage` in `shared/src/remote/messages.ts`) — as plain
JSON frames, the same way a `hello` is, not as an ask: they change the
group rather than asking or answering anything, so no allowlist entry
could reach them even if one tried. `Channel.groups` is this side's read
of the peer's hello: did it name `group`. `Channel.sendGroup(msg)`
sends only when the channel is ready and `groups` is true, and
`receive()` only emits a channel's `group` event once the peer's hello
has arrived and named it — the check runs on both the sending side and
the receiving side, so a channel to a device that never mentions
`group` (any shipped device, or the phone) carries none of these
messages in either direction, by construction.

What is actually built on `group` and these messages — the roster
itself, the merge, linking through the relay, removal and leaving — is
`docs/domains/device-group.md`.
