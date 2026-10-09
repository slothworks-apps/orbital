# Changelog — Orbital for the phone

All notable changes to the phone app, on Android and on iOS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the app version, `version` in `mobile/package.json`, which ships over the air; a line for a change that needs the update from TestFlight or Google Play says so.

## [Unreleased]

## [0.8.0] — 2026-10-09
### Added
- The app updates itself: a new version downloads in the background, and a quiet notice above the session list offers to restart into it, keeping what you are typing. Close the notice and the new version starts the next time you open the app. Only versions signed by Orbital are installed, and one that fails to start is undone on its own. Needs this update from TestFlight or Google Play.
### Changed
- Settings shows the app's version beside the version installed from TestFlight or Google Play, and the fingerprint on a line of its own.
- To deliver updates, the app tells Orbital's own update server a random install id, the phone's model, its system version, the app's versions, whether an update installed, and the errors the app runs into. No name, account or location.

## [0.7.0] — 2026-10-08
### Added
- Orbital asks for Face ID, your fingerprint or your screen lock when you open it, and again after a minute away; you can turn this off in Settings. With it on, the app switcher no longer shows your sessions, and on Android screenshots of the app are blocked.
- Orbital now needs a screen lock on the phone; without one it asks you to set one, and your pairing stays.
### Changed
- Notifications start off on a newly paired phone when they are off on your Mac. A one-time notice above the session list offers to turn on the two that matter most, and the phone asks for permission only then — or when you turn one on in Settings — never at launch or while pairing.
- While pairing, the phone tells you to type its code on your Mac.
- Notifications no longer show your Mac's name; they read "Orbital".
- Your phone's name reaches your Mac encrypted while pairing; the relay in between no longer sees or keeps it. Pairing needs relay 0.4.0 or newer.
- The app has Orbital's own icon on iOS and Android, and Android notifications show Orbital's mark instead of a placeholder.
- Opening the app shows Orbital's mark on the app's dark background until the first screen is ready, instead of a placeholder, with no white flash in between.
- A session that left a dev server or a watcher running on the Mac shows as done once its work is finished, instead of working for as long as the server runs; the server stays listed with the session's tasks.
### Fixed
- A session that asks for input right after it starts on the Mac in a terminal, or just after the phone reconnects, now notifies instead of staying silent.
- Starting a session asks before the Mac runs the MCP servers a project's `.mcp.json` names; a server you have not allowed does not start.
- The app asks for permission to notify only once; after you decline, it no longer asks again on the next start or with each notification.
- A photo from a very high-resolution camera no longer fails to attach for lack of memory, and a second tap while the camera or gallery is open is ignored.
- Notifications are set up on every start, also when the connection to the Mac fails at first.

## [0.6.0] — 2026-10-08
### Added
- When the Mac watches more than one Claude Code folder, each session shows which folder it belongs to, and a new session can be started under the folder you choose.

## [0.5.0] — 2026-10-07
### Added
- A session shows how many other git worktrees its running subagents work in; in the open session, tap the count to see them with their tasks.

### Fixed
- A session shows the branch it works on now, also after it moved into a worktree.
- A file the agent links to opens from the worktree it was working in.

## [0.4.0] — 2026-10-07
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
