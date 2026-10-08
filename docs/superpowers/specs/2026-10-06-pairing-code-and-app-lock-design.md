---
id: 2026-10-06-pairing-code-and-app-lock-design
title: Pairing code typed on the Mac, a required screen lock and an app lock on the phone
type: spec
status: done
domain: remote
related:
  - the-phone-may-do-what-the-mac-may
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - 2026-09-30-mobile-remote-design
  - 2026-10-02-mobile-app-design
  - 2026-10-01-settings-mobile-design
  - why-orbital
tags:
  - mobile
  - pairing
  - security
---
# Pairing code typed on the Mac, a required screen lock and an app lock

**Status: done**, agreed and drawn 2026-10-06 (§ 5), built 2026-10-08 (§ 8).

## Problem

A paired phone can run an agent on the Mac with the user's rights, and that
is on purpose ([[the-phone-may-do-what-the-mac-may]]). The link itself is
sound: the relay can neither read nor inject anything. What is left is
someone other than the user holding a paired phone:

1. **Someone else pairs.** The QR is the only thing a stranger needs to
   redeem the pairing token. A photographed or glimpsed QR, redeemed before
   the user's own phone, puts the stranger's request in front of the Mac. Today
   the Mac shows a six-character fingerprint and asks the user to check it
   against the phone. Most people press Accept without reading it.
2. **Someone holds the user's phone.** Nothing in the app asks who is holding
   it. A phone with no screen lock is open to anyone who picks it up.

## 1. The pairing code is typed on the Mac

- The phone shows the six-character code (`fingerprint(macKey, phoneKey)`)
  as it does today in 9e step 2, and its line changes to "Type this code on
  your Mac".
- The Mac no longer shows the code. Its confirmation (9o) asks for it: six
  character boxes grouped 3 + 3, and Accept stays disabled until all six are
  filled. Reject stays available at any time.
- The direction is deliberate. The Mac is where the pair is accepted, and the
  code it expects belongs to the phone that sent the request. Only a person
  holding that phone can read it. If a stranger's phone redeemed the QR, the
  code in the user's hand does not match, and the pairing fails. The other
  direction (the Mac shows, the phone types) protects less: whoever saw the
  QR on the Mac's screen can most likely see a code there too.
- Input is case-insensitive and normalised to the Crockford alphabet the
  code is drawn from: `O` reads as `0`, `I` and `L` as `1`. Spaces and the
  dash are ignored, so a pasted `ABC-DEF` works.
- **The server compares, not the web client.** `pendingPair` in the remote
  status stops carrying `fingerprint`. `POST /api/remote/pair/confirm` takes
  the typed `code` with `accept: true` and answers `code_mismatch` when it is
  wrong. Reject needs no code.
- **Attempts.** `PAIR_CODE_ATTEMPTS` = 3 wrong codes reject the request, as if
  the user had pressed Reject: the phone gets `rejected` and shows "Code
  expired · scan again". The dialog says how many attempts are left after a
  wrong one. Three is enough for a typo and too few to guess 30 bits.
- **No protocol change.** The phone already shows the code and the relay
  sees nothing new. A phone on an older build pairs with a new Mac unchanged.
  Only its wording ("check that it matches") is out of date.

## 2. The phone requires a screen lock

- The app checks whether the device is secured (a passcode, PIN, pattern or
  password; biometrics on top of it are optional). It checks before pairing
  and on every start and return to the foreground.
- **Without a screen lock the app stops at a blocking screen**: "Set a
  screen lock to use Orbital", one sentence on why ("a paired phone can run
  agents on your Mac"), and a button that opens the system's security
  settings where the platform allows it. Like the version mismatch screen
  (9i), the whole app is behind it. Pairing does not start. A phone that is
  already paired keeps its pairing and its cache, and the app is usable again
  once a lock is set.
- The check needs a screen lock, not biometrics. Face ID and fingerprint
  fall back to the screen lock anyway, so the screen lock is what everything
  else rests on. Requiring biometrics would shut out a user who has a lock
  but no enrolled finger or face, and would protect nothing more.
- Plugin: `@aparajita/capacitor-biometric-auth`, by the author of the
  secure storage plugin already in use. `checkBiometry()` reports both
  `deviceIsSecure` and which biometry is enrolled. Android
  (`KeyguardManager.isDeviceSecure`) and iOS
  (`LAContext.canEvaluatePolicy(.deviceOwnerAuthentication)`) both answer this.
- In a desktop browser (layout work only) the check passes, the same way
  identity storage falls back to `localStorage` there.

## 3. The app lock

- A setting on the phone, 9f under a new SECURITY group: "Require Face ID /
  fingerprint to open" (named after what the device has: Face ID, Touch ID,
  fingerprint, or "screen lock" when no biometry is enrolled). **On by
  default**, including for phones that are already paired when they update.
- When on, the app asks for authentication on a cold start, and on a return
  to the foreground after more than `APP_LOCK_GRACE_MS` = 60 s in the
  background. A quick switch to another app and back does not ask. This
  matters for a calm app that is opened often and briefly
  ([[why-orbital]]).
- Authentication is the system prompt (biometrics with the device passcode
  as fallback, `allowDeviceCredential`). The lock screen behind it shows
  nothing from the Mac: the app's frame, the Orbital mark and "Unlock". A
  cancelled prompt leaves the user on that screen with an "Unlock" button to
  try again.
- **What the lock covers:** the UI. The relay link, its reconnects and
  incoming notifications keep running while the app is locked, so a
  notification still arrives and its tap opens the session after unlocking.
  The identity key is not gated by biometrics in the Keystore/Keychain. The
  key signs every handshake, background reconnects included, and gating it
  would bring up the prompt far too often. Recorded as a possible later
  hardening, not part of this spec.
- Turning the setting off asks for authentication first, so a person holding
  an unlocked app cannot switch it off for later.
- While the lock is on, the app-switcher snapshot shows the lock screen (9t),
  not the last screen. The app draws 9t on the way to the background, and on
  Android `FLAG_SECURE` keeps the system from capturing anything else.

## 4. The phone

This spec is mostly about the phone. § 1 changes the phone's wording only and
needs no new route. § 2 and § 3 live entirely in `web/src/mobile` and the
native shells (the plugin and `FLAG_SECURE` / the iOS cover) and touch no
server route and no part of the allowlist.

## 5. Canvas

Drawn 2026-10-06 in `Feature - Mobile`: **9o** (code entry, states A opened /
B six typed / C after a wrong code), **9e** step 2 ("Type this code on your
Mac"), **9n** (the line under the QR now says the code is typed here),
**9f** (SECURITY group), **9s** (screen lock required) and **9t** (app lock,
prompt up and prompt cancelled). The canvas is the source of truth for what
the user sees. It settles these points beyond the text above:

- 9o: closing the dialog is Reject. Paste works. Typing fills left to
  right, and the next box carries the accent. Whatever the outcome, the QR
  in 9n resets.
- 9t: the app-switcher snapshot shows 9t itself, not a blank screen. The
  screen draws first and the system prompt opens over it. Cancel leaves it
  as is, Unlock opens the prompt again, and success returns to wherever the
  app was.
- 9s: grey mark, no warning icon, no red. "Checked again when you come
  back". The button opens the system settings at the screen-lock page.

The prompt it was drawn from:

> In `Feature - Mobile`, add: (a) a variant of 9o where the Mac asks the user
> to type the six-character code shown on the phone, 3 + 3 boxes, Accept
> disabled until filled, plus a state after a wrong code with attempts left;
> (b) 9e step 2 with the line "Type this code on your Mac"; (c) a full-screen
> phone state "Set a screen lock to use Orbital" in the style of 9i, with one
> explanatory sentence and a button to the system settings; (d) the app lock
> screen: the phone frame, Orbital mark, "Unlock", nothing from the Mac
> visible; (e) a SECURITY group in 9f with the "Require Face ID to open"
> toggle. Keep the 9a–9p frame, tokens and calm. No alarming colours. This is
> a routine step, not a warning.

## 6. Ships

- Desktop: § 1 (dialog, server compare, attempts). Changelog line in
  `desktop/CHANGELOG.md`.
- Phone: § 1 wording, § 2, § 3, new native plugin. Changelog line in
  `mobile/CHANGELOG.md`.
- Relay: nothing.

## 7. Tests

- Server: confirm with the right code, a wrong code (`code_mismatch`, the
  attempt counted), the third wrong code rejecting the request, the
  normalisation (`o`/`O` → `0`, `i`/`l` → `1`, dash and spaces dropped), and
  that the status no longer carries the fingerprint.
- Phone: the pure decision of when to ask (cold start, foreground after the
  grace, a quick return, setting off), with an injected clock.

## 8. As built, 2026-10-08

- The app lock applies only while a Mac is paired; a fresh install has
  nothing to protect and opens straight to pairing.
- 9s replaces the whole app (the scanner cannot start behind it); 9t is an
  overlay, so the screen under it stays mounted and comes back on unlock.
- A device-lock check that fails counts as secure, so a plugin error cannot
  trap the user behind 9s. On iOS 9s has no button, only the path to
  Face ID & Passcode: the plugins that open it use private URLs App Review
  rejects.
- The app-switcher snapshot: Android sets `FLAG_SECURE` while the lock is on
  and a Mac is paired, which also blocks screenshots of the app; iOS draws a
  native copy of 9t over the window in the background.
- After the third wrong code the Mac's dialog closes with a toast instead
  of the canvas's result state; the phone says "Code expired · scan again"
  as § 1 says, not 9o's "Pairing declined".
- Plugin: `@aparajita/capacitor-biometric-auth` 10.

Fidelity pass on the desktop against 9o (states A and C) and 9n, and on the
phone (browser) against 9e step 2 and 9f's SECURITY group: matching after
9o moved to a card variant of `Dialog`. A wrong code, then the right one
typed in lower case with a space, paired through a local relay. 9s was seen
on the Android emulator; 9t and the iOS cover still want a real device.
