# Changelog — Orbital for Android

All notable changes to the Android app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `versionName` in `mobile/android/app/build.gradle`.

## [Unreleased]
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
