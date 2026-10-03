---
id: the-connected-phone-notifies-itself
title: The connected phone notifies itself; the relay pushes only when it is gone
status: in-force
type: adr
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-10-02-mobile-app-write
  - 2026-09-30-mobile-remote-design
tags:
  - mobile
  - relay
  - notifications
---
# The connected phone notifies itself; the relay pushes only when it is gone

**Decided 2026-10-02**, brainstorming phase 2b of
[[2026-10-02-mobile-app-design]] (§ 6.5).

## Context

The relay is blind: it pushes a generic "a session needs your input" through
Firebase Cloud Messaging, and only for a phone that is not connected to it
([[2026-09-30-mobile-remote-design]] § 5). Android does not cut a
backgrounded WebView's socket at once — it lives for a while, sometimes
minutes — and in that window the relay sees the phone connected and pushes
nothing. The user has put the app away and hears nothing about a session
that just asked.

Two ways out were on the table.

**Close the link on every pause.** The app stops its relay link when it goes
to the background, so the Mac sees it offline, the Mac flags its frames
`wake`, and the relay pushes. One notification path, no local-notification
plugin, nothing to keep in sync, and the socket costs no battery while the
app is away.

**Keep the link and notify locally.** The app stays connected while the OS
lets it, receives the hub frames, decrypts them and posts a local
notification with the session's name and the ask — the behaviour the parent
spec described. The relay's generic push covers the time after the OS kills
the socket. Two paths, and the app needs `@capacitor/local-notifications`
next to `@capacitor/push-notifications`.

## Decision

Keep the link and notify locally. A connected phone shows the specific
notification; a disconnected one gets the relay's generic push. The two
cannot double up: the relay pushes only when the phone is not connected, and
a phone that is not connected receives no hub frame. The wake frames the
relay queues for an offline phone arrive on reconnect with an empty body and
are ignored, as the phone client contract already says.

The deciding points: a notification that names the session is the one worth
having, and the parent spec's "Mac applies the phone's rules when it decides
`wake`" already assumes the phone filters its own notifications while it is
connected. Disconnecting on pause would also show the Mac an offline phone
whose owner is one swipe away, and would turn every notification into the
generic one.

The in-app banner is not a notification: it is the foreground's way of
showing the same transition, and the phone's "only when the app is in the
background" rule governs the system notification alone.

## Consequences

- The phone runs the shared `SessionNotifier` over its hub frames, with its
  own rules from the Mac, rebuilds it on every new tunnel and seeds it from
  the session list the resync reads — the hub replays nothing on subscribe,
  so an unseeded notifier would swallow each session's first transition
  after a reconnect (the desktop seeds its watcher the same way).
- Two notification channels exist on Android: the silent one the relay
  addresses and a sounding one for local notifications, because a channel's
  sound cannot change after it is created and the relay does not know the
  phone's `sound` rule.
- When the OS kills the socket, the next transition is reported by the
  relay, generically, and the one in flight at that moment is lost — the
  same gap a desktop has when its window is closed. Opening the app resyncs.
