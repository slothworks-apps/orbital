# Changelog — Orbital for the phone

All notable changes to the phone app, on Android and on iOS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `versionName` in `mobile/android/app/build.gradle`.

## [Unreleased]
### Added
- When the relay or this app is too old for the others, the app says which one and shows both versions; for the app, it opens Google Play to update.

### Fixed
- The settings screen shows the app's real version, and the app reports that version to the Mac.

## [0.3.2] — 2026-10-06
### Fixed
- An open session shows every subagent it has run, now that the Mac sends only the running ones with the session list.

### Changed
- The Ended group loads its sessions when you open it, so the list arrives faster.

## [0.3.1] — 2026-10-06
### Fixed
- An open session shows all the background commands it has run, also with a Mac that sends only the running ones with the session list.

## [0.3.0] — 2026-10-05
### Added
- Answer a harness step waiting for your OK — approve it, reopen it or go back — and see the plan's steps and what each one did.
- Tap a file path or an image in a session to see it full screen, with zoom; text files open as a read-only preview, and what you have seen stays available while the Mac sleeps.
- Open a subagent's own conversation and a background task's live output, and stop a running task.
- A ⋯ menu on a session to rename it, change its tag, pin it, clear and start over, or end it; pinned sessions lead the list.
- See when a session is waiting for its usage limit to reset, cancel or undo its automatic continue, and how full its context is.

### Changed
- Needs Orbital 0.20.6 or newer on the Mac.
- The subagents row in the list shows a dot only for the subagents still running.

## [0.2.0] — 2026-10-05
### Added
- Orbital runs on the iPhone: pair it with your Mac, follow and answer your sessions, and get a notification when one needs your input, the same as on Android.

## [0.1.2] — 2026-10-05
### Changed
- Every screen now matches the app's design: sessions show as small planets in their state's colour, the main buttons are solid and bright, New session stays at the bottom of the list, a long folder list folds behind "Show all", and pairing, settings and the notice screens are laid out as designed.

### Fixed
- The notification switches in Settings no longer stick out of their track, and the tag chips above the session list no longer show a scrollbar.

## [0.1.1] — 2026-10-04
### Added
- When you scroll up in a session's transcript, a quiet button takes you back to the latest message and says when something new has arrived below. Sending a message also takes you back to the bottom.

### Fixed
- A question's answer options in a session's transcript now show their whole text instead of cutting off long descriptions or long paths.

## [0.1.0] — 2026-10-04
### Added
- Pair the phone with a Mac running Orbital: scan the QR code from the Mac's Settings → Mobile, or paste the code, then confirm that the short code matches on both screens. Everything between the phone and the Mac travels end-to-end encrypted through your relay.
- A session list with the Mac's sessions grouped by tag, their state and tags; when the Mac is offline, the last known list is shown with a notice.
- A session's transcript, loaded page by page, with a divider marking where cached history ends while the Mac is offline. Thinking reads as ordinary text, image paths open in a full-size preview, and a session waiting for a usage limit shows its wait in the transcript.
- Write to a session from the phone: send messages with photos from the camera or the gallery, answer questions and permission requests, and see when a session is compacting.
- Start a new session on the Mac from the phone, choosing its folder, model and permission mode.
- Notifications when a session needs your input or ends, through push while the app is in the background and a quiet in-app banner while it is open, following the notification rules you set on the phone.
- Settings for the paired Mac, this phone's notification rules and the relay; forgetting the Mac clears its data from the phone and stops its pushes.
- A relay that requires a secret is supported: the secret comes with the pairing QR code, and a refused secret during pairing sends you back to scanning.
- A screen for a phone the Mac has unpaired, and one for when the phone and the Mac run versions that cannot talk to each other.
- The phone learns that the Mac removed it even if that happened while the app was away.
### Changed
- The status bar uses light icons on the app's dark background whatever the system theme.
### Security
- The app's data is excluded from Android backups, since the caches are stored in plain text and the identity key stays on the device.
