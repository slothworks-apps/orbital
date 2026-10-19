---
id: 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design
title: The phone is quiet while you are at the Mac, and shows one notification per session
status: done
type: spec
domain: remote
related:
  - the-connected-phone-notifies-itself
  - 2026-10-08-notifications-off-by-default-design
  - 2026-09-30-mobile-remote-design
  - why-orbital
tags:
  - notifications
  - mobile
  - relay
  - desktop
---
# The phone is quiet while you are at the Mac, and shows one notification per session

## Problem

Two things make the phone louder than it needs to be.

**It buzzes while you sit at the Mac.** "Only when Orbital is in the
background" is judged by each device on its own. The phone sees its own app
in the background and notifies, and the Mac sends a `wake` for every
transition the phone's rules let through, whether or not anyone is at the
Mac ([[the-connected-phone-notifies-itself]]). Someone typing at the Mac
gets a vibration in their pocket for a session they are looking at.

**Notifications pile up.** Every finished turn moves a session to
`needs_input`, so two sessions running side by side produce a steady stream
of them. The phone's own notifications already carry one id per session and
replace each other. The relay's generic pushes do not: FCM's `collapse_key`
only collapses messages still waiting for delivery, so on Android every push
lands as a new row in the shade.

## Decision

### 1. The Mac says when you are at it

The desktop app decides whether the user is at the Mac: the screen is not
locked and the system has seen keyboard or mouse input within
`PRESENCE_IDLE_SECONDS`, in Orbital or any other app. It polls this every
`PRESENCE_POLL_MS` and reports it to its server with `PUT /api/presence`:
`{ atMac: true }` on every poll while present (a heartbeat), `{ atMac:
false }` once when that ends, and at once when the screen locks or the Mac
sleeps.

The server holds presence with an expiry (`PRESENCE_TTL_MS`, longer than
the poll). A heartbeat extends it; `atMac: false`, or no heartbeat before
the expiry, ends it. A desktop app that crashes or quits therefore cannot
keep the phone silent. A server with no desktop app (`npm run dev` in a
browser) never hears a heartbeat and behaves as before.

Every change of presence is published on the hub topic `presence` as
`{ event: 'state', atMac }`.

### 2. While you are at the Mac, the phone notifies nothing

- **Wake.** `DeviceWatcher` still folds every frame, so its state stays
  right, but sends no `wake` while presence holds. The relay then pushes
  nothing. A transition muted this way is not sent later: the Mac's own
  map and notifications were the place for it.
- **Local notification.** The phone subscribes to `presence`. Its
  `PhoneSession` answers the subscription with the current state, since the
  hub replays nothing. While `atMac` is true the phone posts no system
  notification. The in-app banner still shows: someone looking at the phone
  is not interrupted by it.

### 3. One notification per session, showing its latest state

- **Relay push.** The relay tags each push with the wake token (Android
  `notification.tag`, APNs `apns-collapse-id`). The token is the per-session
  HMAC the relay already receives and cannot read, so a later push for the
  same session replaces the earlier one and the relay learns nothing new.
  Since every push now stands for one session, the text no longer counts:
  "A session needs your input" — since made neutral, "A session has an
  update", once a wake could also be a finished turn
  ([[a-finished-turn-is-done-not-needs-input]]). The relay's per-phone count
  (`WakeTracker`) goes with it.
- **Local notification.** It already replaces per session. In addition,
  when a session leaves `needs_input` (answered at the Mac, or moving on),
  the phone takes that session's notification off the shade.

A relay push and a local notification for the same session can still both
show: the phone cannot map a wake token back to a session. Opening the app
clears the shade, as it already does.

## Phone

Built for the phone, which is where the change is felt. The phone
subscribes to `presence` without a `MAC_FEATURES` gate: an older Mac drops
a subscription to a topic it does not allow (`phoneMayWatch`) without an
answer, and the phone then never hears `atMac: true` and notifies as before.
Nothing waits on a reply, so nothing times out. `presence` joins
`PHONE_ALLOWED_TOPICS`.

## Consequences

- Leaving the Mac does not replay what was muted while you were there. A
  session that asked while you were present and is still waiting when you
  walk away says nothing on the phone until its next transition.
- Presence is the Mac's, not the Orbital window's: working in an editor
  next to Orbital counts as being at the Mac.
- The relay change ships separately from the Mac's. A relay that still
  counts keeps stacking pushes until it is redeployed; the Mac and the
  phone do not depend on it.
