---
id: 2026-11-26-push-carries-its-text-sealed-design
title: The relay's push carries its text sealed for the phone
status: draft
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - the-connected-phone-notifies-itself
  - 2026-10-08-relay-knows-no-names-design
  - 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design
  - why-orbital
tags:
  - mobile
  - relay
  - notifications
  - security
---
# The relay's push carries its text sealed for the phone

**A proposal for the maintainer to decide on.** Nothing here is built.

## Problem

When the OS has taken the phone's socket, every update reaches it as
"Orbital — A session has an update" ([[the-connected-phone-notifies-itself]]).
It does not say which session or what it wants, so each one is a reason to
open the app only to find out whether it matters. The phone's own
notifications, posted while it is still connected, name the session and the
ask; which of the two the user gets depends on how long ago the OS suspended
the app, which the user cannot see.

[[2026-09-30-mobile-remote-design]] § 2 ruled out a backend that sees content
and named this as the v2 option: "Decrypting content inside the notification
(iOS Notification Service Extension)". This spec is that option.

## What must stay true

- The relay, FCM and APNs never see a session name, a question or any other
  text from a session ([[2026-10-08-relay-knows-no-names-design]]).
- The rules for what deserves a notification stay on the Mac, as today.
- A phone that cannot open the sealed text shows today's generic line, never
  nothing.

## Design

### 1. The Mac seals the text

When the Mac decides a wake for a phone (`DeviceWatcher.onWake`), it also
builds the notification the phone would have posted itself — the same
`SessionNotifier` title and body, cut to 160 characters — and seals it to the
phone's **identity public key** (X25519, which the Mac already holds from
pairing): an anonymous sealed box, an ephemeral key per message plus
XChaCha20-Poly1305, padded to a fixed 256 bytes so the length says nothing.
The channel's session keys cannot be used: the phone's next handshake
replaces them, which is why the relay's queue keeps empty-body frames only.

The sealed bytes travel in the wake frame under a new flag, `FLAG_SEALED`
(the body is otherwise empty for a wake), so a connected phone, which ignores
wake bodies, is unaffected.

The Mac seals only for a phone whose hello says its shell can open it (a new
capability, `sealed-push`); for any other phone the frame stays as today.

### 2. The relay forwards it, blind

For a wake frame with `FLAG_SEALED` and a phone that is not connected, the
relay sends the sealed bytes, base64, in the push's data (`data.sealed`, next
to `data.tag`). A frame without the flag gets today's push. The relay
learns nothing new: it sees 256 opaque bytes per wake instead of none.

- **iOS:** the alert keeps today's generic title and body and gains
  `mutable-content: 1`; a Notification Service Extension opens `sealed` and
  replaces the text. If it cannot (no key, a bad box, its 30 s run out), iOS
  shows the generic line.
- **Android:** a data-only, high-priority message; a
  `FirebaseMessagingService` in the shell opens `sealed` and posts the
  notification itself on the channel the phone's sound rule picks. If it
  cannot, it posts the generic line.

### 3. The phone opens it natively

Both are native code in `mobile/`, so this is a **store build** (a native
version bump), not an OTA bundle.

- The identity secret key today sits in `@aparajita/capacitor-secure-storage`
  (`orbital.identity`). The iOS extension is a separate process: the key must
  move to a Keychain access group the app and the extension share. On Android
  the service runs in the app's process and reads the same Keystore-backed
  entry.
- The box is opened with libsodium (`Sodium` / `lazysodium-android`) or a
  hand-written X25519 + XChaCha20-Poly1305 over the platform's crypto —
  new native dependencies, to be agreed first.
- A tap opens the session, as PR #228 makes the generic push do.

## Scope

- For: everyone with phone notifications on.
- Lives: an option, **Settings → Notifications → Show what happened**, on by
  default for new installs? — or Labs first while reception is unknown.
  Open question for the maintainer.
- An existing user notices: after the store update, notifications name the
  session and the ask even when the app was asleep.
- Can be set: the option above; off sends today's generic line (for a lock
  screen others can see). iOS's own "Show previews" setting still applies.

## Phone

The feature is the phone's. It needs a new shell (store build), a Mac that
seals (gated in `MAC_FEATURES` and by the `sealed-push` capability) and a
relay that forwards `FLAG_SEALED`. Any older one of the three leaves the
generic push, so they can ship in any order.

## Costs and risks

- A second process holding the identity key on iOS; the key's Keychain item
  changes access group, which is a migration on every installed phone.
- Native crypto in two languages, beside the TypeScript one, to keep in
  agreement — test vectors shared from `shared/`.
- Android may defer data-only messages from an app the user rarely opens;
  high priority is honoured only while the app posts a notification for each.
- The relay can still count wakes, as today; padding keeps it from reading
  the length of the text.

## Open questions

1. Labs or an option on by default?
2. libsodium on both platforms (two new dependencies), or hand-written over
   CryptoKit / Tink?
3. Is moving the identity key into a shared Keychain group acceptable, or
   should the extension get its own key pair, registered with the Mac at
   pairing?
