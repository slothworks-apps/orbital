# Changelog — Orbital for the phone

All notable changes to the phone app, on Android and on iOS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the app version, `version` in `mobile/package.json`, which ships over the air; a line for a change that needs the update from TestFlight or Google Play says so.

## [Unreleased]
### Fixed
- A subagent's detail names its model as soon as the agent takes its first step, instead of only once it writes text, often at the very end. For a session started in Orbital, needs an updated Mac.

## [0.20.0] — 2026-10-23
### Added
- File previews show code in colour, and a markdown file opens as a formatted document, with a switch to its source.
- Take over a session running in a terminal on the Mac, from its ⋯ menu: the CLI there quits and the conversation goes on in Orbital. Needs an updated Mac.
### Changed
- Question cards no longer send with the last answer: tap an answered question to change it, and nothing is sent until you tap Send. Your Mac's Review answers before sending setting decides whether the review shows.
- The Limits button in the session list's header loses its frame and sits beside Settings as its equal.
### Fixed
- A new session's first prompt can carry a photo and start a command or skill: the camera, gallery and / buttons sit under the field, as in a running session.
- Copying text selected in a file preview no longer copies the line numbers with it.

## [0.19.0] — 2026-10-21
### Added
- When a session's profile loses its login, log it in again from the phone: open the sign-in page, paste the code it shows, and the session continues on the Mac. Needs the "Upkeep of this Mac" permission and an updated Mac.
### Changed
- New session calls the Claude directory a profile.

## [0.18.3] — 2026-10-21
### Changed
- Under IDLE, sessions that finished a turn you have not read yet (hollow centre) come first, before the quiet ones.

## [0.18.2] — 2026-10-21
### Changed
- Planets in the session list take their tag's colour, as on the Mac's map, instead of the colour of their state; the section and the planet's shape still say what each session is doing.

## [0.18.1] — 2026-10-21
### Fixed
- Settings → Devices no longer shows an awake Mac as asleep: a device's state follows it coming online and going away.

## [0.18.0] — 2026-10-20
### Added
- Settings → About → Send feedback opens a bug report or a feature request on GitHub in your browser, with the app version, the system and the phone model filled in.

## [0.17.0] — 2026-10-20
### Added
- Limits, from the ring in the session list header: every Claude account's plan windows across your devices, with when each runs out at your current pace.

## [0.16.0] — 2026-10-20
### Added
- After an update, a WHAT'S NEW message above the session list shows what changed in the phone app.
- Devices shows each device's version, and a device with a newer version gets Update in its sheet: update your server or your Mac from the phone, now or once its sessions finish.
- The phone's own code says how to add a server: `orbital join` on the server.

## [0.15.4] — 2026-10-19
### Fixed
- On iPhone, attaching a photo works again: it used to fail with "Couldn't take that photo" before the camera or the library opened. Needs this update from TestFlight.

## [0.15.3] — 2026-10-19
### Fixed
- The banner inside the app no longer says a session needs your input when it has only finished its turn. It says Done instead, and shows nothing if the session carries on by itself a moment later.

## [0.15.2] — 2026-10-19
### Changed
- A session compacting its context shows it in the session list too: its planet goes quiet and grey rings draw in onto it, as on the Mac's map.

## [0.15.1] — 2026-10-19
### Fixed
- The Copy button on code blocks in a transcript is always shown; before, it appeared only on hover, which a phone does not have.
- The "Cleared" and "Ended" line at the end of a transcript goes away after a few seconds instead of staying until you leave the session.

## [0.15.0] — 2026-10-17
### Added
- The phone joins your group of devices: it reaches every desktop and server in the group on its own, so a sleeping Mac takes away only its own sessions. Pairing with one device links the phone with the rest. Needs the Mac update that brings device groups; with an older Mac the phone works as before.
- The session list shows a chip per device to show or hide its sessions, names each session's device, and says which device is asleep.
- Settings → Devices lists every device in the group and names the one that manages it; join a group by showing this phone's code, or leave it.
- New session asks which device the session runs on.

## [0.14.0] — 2026-10-16
### Added
- Photos and screenshots of any size go to a session: the phone brings them down to the size Claude takes, and converts iPhone HEIC photos.
### Changed
- Images in a transcript and in Media load as small thumbnails, much faster over a slow connection; the full image loads when you open it. Needs the Mac update that brings it.

## [0.13.0] — 2026-10-15
### Added
- A session's Media also shows its subagents' images and images the agent saved to disk without mentioning them. Needs the Mac update that brings them.
- Media tiles show the whole image instead of a cropped square, with the file's name or where it came from underneath.
### Changed
- A Sources sheet replaces Hide tool images: choose which kinds of images Media shows, and the button says when something is hidden.

## [0.11.0] — 2026-10-15
### Changed
- The phone no longer notifies while you are working at your Mac; it notifies again once the Mac is locked or left alone for a few minutes. Needs a Mac with this update.
- A session's "needs your input" notification goes away by itself once the session moves on.

## [0.10.3] — 2026-10-15
### Added
- Filter by multiple tags at once: tap to select only that tag, long-press to add or remove it from the selection.

## [0.10.2] — 2026-10-15
### Changed
- Messages are rendered by a newer version of the Markdown library; nothing should look different.

## [0.10.1] — 2026-10-12
### Added
- Tapping the project and branch in a session's header opens a panel instead of a tooltip: the full branch name, its line changes and its pull request — state, review and checks — with a button that opens the pull request on GitHub.
### Changed
- An image that is still loading shows a small, slow moon instead of a striped placeholder, and only when the load takes a moment; the full-screen viewer fills its orbit as the bytes arrive.
- Going back to an image you have just looked at shows it at once instead of loading it again; an image from a file is still checked with the Mac in the background and updates if the file changed.

## [0.10.0] — 2026-10-12
### Added
- New session tells you, as you type, when the folder doesn't exist on your Mac, and offers to create it when you start. Needs Orbital for Mac 0.29.0 or newer.

## [0.9.2] — 2026-10-09
### Added
- A `/` button under the message field: it starts a slash command and opens the list of commands and skills, without hunting for the slash on the keyboard.
- Tap a session's title, or its project and branch, at the top of a session to read them whole when they are cut short.

## [0.9.1] — 2026-10-09
### Added
- Change a session's model and permission mode from its header: tap the model or the mode dot. A model switch asks first, as on the Mac, because the next message costs more.

## [0.9.0] — 2026-10-09
### Added
- Media: every image and PDF of a session, from the session menu — a gallery that hides tool screenshots if you like, and a viewer you swipe through, with PDFs shown page by page and a way back to the message in the chat.
- Images and PDFs the agent names in a reply show as thumbnails under it.
- With an older Orbital on the Mac, Media and PDF previews stay hidden until the Mac is updated; everything else works as before.

## [0.8.2] — 2026-10-09
### Fixed
- `/compact` and other slash commands sent from the phone run again while a file is open in the editor on your Mac; before, they reached Claude as an ordinary message.

## [0.8.1] — 2026-10-09
### Changed
- Menus and sheets — the session's ⋯ menu, context, subagents, worktrees, harness steps and every confirmation — slide up from the bottom and back down when they close, instead of popping in and out.

## [0.8.0] — 2026-10-09
### Added
- The app updates itself: a new version downloads in the background, and a quiet notice above the session list offers to restart into it, keeping what you are typing. Close the notice and the new version starts the next time you open the app. Only versions signed by Orbital are installed, and one that fails to start is undone on its own. Needs this update from TestFlight or Google Play.
### Changed
- Settings shows the app's version beside the version installed from TestFlight or Google Play, and the fingerprint on a line of its own.
- To check for updates, the app tells Orbital's own update server a random install id, the platform, its system version and the app's versions. With Settings → Send diagnostics on, which it is unless you turn it off, it also reports whether updates installed, that an error or a crash of a given kind happened — never its text or anything from your sessions — and the phone's model. No name, account or location.

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
