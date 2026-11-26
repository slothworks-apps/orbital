---
id: 2026-11-26-push-tap-opens-the-session-design
title: A tap on the relay's push opens its session
status: done
type: spec
domain: remote
related:
  - the-connected-phone-notifies-itself
  - 2026-09-30-mobile-remote-design
  - 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design
tags:
  - mobile
  - relay
  - notifications
---
# A tap on the relay's push opens its session

## Problem

When the OS has taken the phone's socket, a session's update reaches it as
the relay's generic push ([[the-connected-phone-notifies-itself]]). A tap on
it opens the session list, and the user has to find the session that asked.
The phone's own notifications, sent while it is still connected, open their
session.

## Design

The relay already holds a token per session: the wake token, the Mac's
HMAC of the session id, which it uses as the notification's tag
([[2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design]]). It
cannot read it, and it stays that way.

1. **Relay.** The FCM message carries the same token in `data.tag` too, where
   a tap can read it. FCM and APNs already see it as the tag and the
   collapse id; nothing new leaves the relay.
2. **Mac.** Each wake it sends is remembered in memory: token → session id,
   the last 500 sessions. `GET /api/wake/:tag` answers `{ sessionId }` or
   404. It is on the allowlist in the `sessions` grant group; its answer is a
   session id the member could list anyway. A restart forgets the tokens.
3. **Phone.** A tap on a push with a tag opens the list as before, waits up
   to ten seconds for the tunnel, asks every device that is up (the push does
   not say which sent it), and opens the session the first one names — only
   if the list is still on screen, so a user who has moved on is not yanked
   away. No answer leaves the list.

The Mac's secret never leaves it, and the relay learns nothing new.

## Scope

- For: everyone with phone notifications on.
- Lives: on by default; it is the behaviour the phone's own notifications
  already have.
- An existing user notices: a tap on "A session has an update" opens the
  session instead of the list.
- Can be set: nothing.

## Phone

Built for the phone. It needs a Mac that serves `GET /api/wake/:tag`, gated
as `wakeOpen` in `MAC_FEATURES`; against an older Mac, or an older relay that
sends no `data.tag`, the tap opens the list as before. Ships over the air:
the native shell already passes a push's data to the tap listener on both
platforms.

## Not in this change

The push's text stays generic. Naming the session needs the text sealed for
the phone and opened before the OS shows it, which is native code and a
store build, proposed in its own spec.
