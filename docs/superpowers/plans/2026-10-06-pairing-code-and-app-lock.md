---
id: 2026-10-06-pairing-code-and-app-lock
title: Pairing code and app lock — implementation plan
type: plan
status: draft
domain: remote
related:
  - 2026-10-06-pairing-code-and-app-lock-design
  - the-phone-may-do-what-the-mac-may
tags:
  - mobile
  - pairing
  - security
---
# Pairing code and app lock — implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. One
> implementer per task. Tasks inside a track run in order. Tracks A and B
> touch disjoint files and may run in parallel in one worktree, each staging
> only its own paths.

**Goal:** build [[2026-10-06-pairing-code-and-app-lock-design]]. The Mac
asks for the code shown on the phone, the phone refuses to run without a
screen lock, and an app lock that is on by default guards the phone app.

**Before starting:** the user hands over a zip of the Claude Design canvas
(`Feature - Mobile`, artboards 9e, 9f, 9n, 9o, 9s, 9t). Read the artboards
from the zip, not through `DesignSync`: `Feature - Mobile.dc.html` is past
`get_file`'s 256 KiB limit and comes back cut. Never write that file back.

## Track A — the Mac (desktop)

### A1. Server: the code is compared on the Mac

Files: `shared/src/remote/keys.ts`, `server/src/remote/service.ts`,
`server/src/api/remoteRoutes.ts`, `server/test/remoteService.test.ts`,
`server/test/remoteRoutes.test.ts`.

- `normalizePairingCode(input)` in `keys.ts` next to `fingerprint`:
  uppercase; drop spaces and `-`; map `O`→`0` and `I`/`L`→`1`. Returns the
  string, which the caller compares to the fingerprint.
- `RemoteStatus.pendingPair` loses `fingerprint` and gains `attemptsLeft`.
  The service keeps the expected code in a private field next to
  `pendingPair` and resets it whenever `pendingPair` is replaced or cleared.
- `PAIR_CODE_ATTEMPTS` = 3, a named constant in the service.
- `confirmPairing(accept, phone, code?)` returns a discriminated result
  instead of a boolean: `ok` · `code_mismatch` (with `attemptsLeft`) ·
  `code_rejected` (the third wrong code: the service posts the relay's
  `/pair/confirm` with `accept: false`, clears the request and publishes the
  status) · `relay_error`. A wrong code that is not the last one changes
  nothing on the relay and publishes the status with the lower
  `attemptsLeft`.
- Route: with `accept: true`, `code` must be a string (400 otherwise). It
  answers 422 `{ error: 'code_mismatch', attemptsLeft }`, 409
  `{ error: 'code_rejected' }`, and keeps its 404 / 409 `mismatch` / 502.
  Reject (`accept: false`) ignores `code`.
- Tests: the right code (including lowercase, `O`/`I`/`L` and `ABC-DEF`
  spellings) pairs. A wrong code answers 422 and counts down. The third
  wrong code rejects on the relay and clears the request. A new request
  after that starts with full attempts. The status never carries the code.
  Reject works without a code.

### A2. Web: 9o asks for the code, 9n's line

Files: `web/src/lib/types.ts`, `web/src/lib/api.ts`,
`web/src/panels/PairConfirmDialog.tsx`, a new code-input component under
`web/src/ui/` (or `FingerprintBoxes` reworked into one, whichever reads
better against 9o), `web/src/panels/MobileSection.tsx`.

- `api.confirmPairing(accept, phone, code?)` and its result types follow A1.
- 9o: six boxes 3 + 3. Typing fills them left to right and the next box
  carries the accent. Backspace steps back. Paste fills all six. Input is
  not case-sensitive. Accept is disabled until all six are filled. Reject is
  always available. Closing the dialog (Esc, the backdrop, ✕) sends Reject.
  After `code_mismatch` the boxes clear and the line "That code didn't match
  · N attempts left" shows. `code_rejected` closes the dialog with the
  "Request rejected" toast.
- 9n: the line under the QR becomes the canvas's text ("You'll type the
  six-character code from the phone here before it connects.").
- Fidelity pass against 9o and 9n, done by the main session (subagents
  have no canvas access).

### A3. Desktop changelog

`desktop/CHANGELOG.md` under `## [Unreleased]`, one line, for example:
"Pairing a phone now asks you to type the code shown on the phone, so a
stranger who saw your QR code can't pair in your place."

## Track B — the phone

### B1. Plugin and platform wrapper

Files: `web/package.json`, `mobile/package.json`, `mobile/ios/App/App/Info.plist`,
new `web/src/mobile/platform/deviceLock.ts`.

- Add `@aparajita/capacitor-biometric-auth` to both `package.json`s at the
  same version, then `npx cap sync` for Android and iOS. Check that the
  version supports Capacitor 8.
- iOS `Info.plist`: `NSFaceIDUsageDescription` ("Orbital uses Face ID to
  unlock the app.").
- `deviceLock.ts`: `deviceIsSecure(): Promise<boolean>`,
  `lockLabel(): Promise<'Face ID' | 'Touch ID' | 'fingerprint' | 'screen lock'>`,
  `authenticate(): Promise<boolean>` (`allowDeviceCredential: true`; a
  cancel is `false`, never a throw). In a desktop browser:
  secure = true, authenticate = true, the same dev-only stance as
  `identity.ts`.

### B2. Pure logic: when to ask

Files: new `web/src/mobile/lock.ts`, `web/src/mobile/constants.ts`
(`APP_LOCK_GRACE_MS`), new `web/src/test/mobilelock.test.ts`.

- `lockOnStart(enabled)` and
  `lockOnForeground({ enabled, backgroundedAt, now })`. They ask on a cold
  start and after more than `APP_LOCK_GRACE_MS` in the background.
- Tests: cold start on and off, a return just under and just over the
  grace, setting off. Use an injected clock.

### B3. State and wiring

Files: `web/src/mobile/state.ts`, `web/src/mobile/boot.ts`,
`web/src/mobile/MobileApp.tsx`, `web/src/mobile/platform/pairing.ts` (or a
small new Preferences key for the setting).

- The setting `orbital.appLock` in Preferences, default on when absent. That
  covers phones already paired before the update.
- Two gates above every screen, checked in this order: `screenLock` (9s,
  `deviceIsSecure()` false) and then `locked` (9t). They are flags in the
  mobile state rather than `BaseScreen` values, so the screen underneath is
  kept and comes back on unlock, as 9t asks ("success returns to wherever
  the app was").
- Boot: check `deviceIsSecure` before pairing or connecting the UI, then
  `lockOnStart`. On `appStateChange`: on the way out, record
  `backgroundedAt` and raise `locked` right away when the lock is on (so
  the app-switcher snapshot shows 9t). On the way back, check
  `deviceIsSecure` again, and if `lockOnForeground` says no, drop `locked`
  without a prompt.
- The relay link, push and local notifications are untouched by both gates.
  A notification tap while locked is held and opened after unlock (extend
  `mayOpenFromNotice` or hold the target next to it).
- State transition tests in the existing mobile state test file: the gates
  keep the screen underneath, and a notice opened while locked waits.

### B4. Screens

Files: new `web/src/mobile/screens/ScreenLockScreen.tsx` (9s), new
`web/src/mobile/screens/LockScreen.tsx` (9t),
`web/src/mobile/screens/PairingScreen.tsx` (9e line),
`web/src/mobile/screens/SettingsScreen.tsx` (9f SECURITY).

- 9t draws first and opens the system prompt over itself. Cancel leaves the
  screen. Unlock opens the prompt again.
- 9s button: Android opens `Settings.ACTION_SECURITY_SETTINGS`. iOS cannot
  deep-link to the passcode page, so it opens the app's settings page
  (`app-settings:`) or, if that proves pointless, the button reads the
  instructions instead. Settle it on the device and note the outcome in the
  spec. Opening an Android intent may need a few lines in `MainActivity` or
  an existing plugin. Prefer an existing plugin when one does exactly this.
- 9f: one toggle whose label comes from `lockLabel()`. Turning it off calls
  `authenticate()` first and stays on if that fails.
- 9e step 2: "Type this code on your Mac".

### B5. The app-switcher snapshot

Files: `mobile/android/app/src/main/java/io/slothworks/orbital/mobile/MainActivity.java`,
`mobile/ios/App/App/SceneDelegate.swift`.

- First, try B3's approach alone: 9t rendered on the way to the
  background. Check on the device whether the snapshot shows 9t. iOS
  usually takes it after `sceneWillResignActive`, but Android may capture
  before the WebView repaints.
- If the snapshot still shows content: on iOS, cover the window with a plain
  view in `sceneWillResignActive` and remove it in `sceneDidBecomeActive`.
  On Android, set `FLAG_SECURE` while the lock is on. That also blocks
  screenshots of the app, and the spec should say so if it comes to that.

### B6. Phone changelog

`mobile/CHANGELOG.md` under `## [Unreleased]`, for example: "Orbital now
needs a screen lock on the phone, and asks for Face ID or your fingerprint
when you open it (you can turn that off in Settings)." and "The pairing
screen tells you to type the code on your Mac."

## Verification

- `npm test` in `server/` and `web/` (the web typecheck through its npm
  script).
- Desktop: pair a real phone against a local relay (fidelity recipe:
  built web on :4848, relay on :4840). Try the right code, two wrong codes
  and then the right one, three wrong codes, close = Reject, and paste.
- Android: the AVD (`Samsung_Galaxy_S24_Ultra`) with no screen lock shows 9s.
  Set a PIN and the app opens. Enroll a fingerprint, then check the app
  lock at launch, after a quick switch (no prompt), after more than a minute
  (prompt), the recents snapshot, and a notification tapped while locked.
- iOS: the same on a device or simulator (simulator: Features → Face ID →
  Enrolled / Matching Face).

## Finishing

- Ask about version bumps: desktop (A, a feature → minor) and phone
  (B, a feature → minor). The relay is not touched.
- Spec status → `done` with an "As built" section for whatever B4 and B5
  settled. This plan → `done`.
