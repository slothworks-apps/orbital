---
id: encrypted-push-payloads
title: Encrypted push payloads that can name the session waiting
status: backlog
type: idea
domain: remote
related:
  - 2026-10-08-relay-knows-no-names-design
tags:
  - push
  - mobile
  - privacy
---
# Encrypted push payloads that can name the session waiting

Since [[2026-10-08-relay-knows-no-names-design]] a push says only that a
session (or N sessions) needs input, with no Mac name and no session title,
because everything in it crosses the relay and FCM/APNs in the clear.

## The idea

The Mac seals what the notification should say — the session's title, what
it waits for, the Mac's name — with a key shared with the phone at pairing,
and sends the blob with the `wake`. The relay passes it on in a data
message it cannot read.

- **Android:** a data-only, high-priority FCM message; a native
  `FirebaseMessagingService` opens it with the key from the app's secure
  storage and posts the notification itself.
- **iOS:** `mutable-content` with the generic text as the visible alert; a
  Notification Service Extension opens the blob and rewrites the alert. It
  needs the key in a keychain access group shared with the extension (an
  App Group), and falls back to the generic text when anything fails.

## Cost

Native code on both platforms, a second iOS target, and key handling outside
the WebView. The relay changes little: it forwards an opaque field.
