---
id: demo-mode-for-store-review
title: A demo mode on the phone, so store review can use the app without a Mac
status: backlog
type: idea
domain: mobile
related:
  - 2026-10-05-ios-app-design
tags:
  - mobile
  - release
---
# A demo mode on the phone, so store review can use the app without a Mac

The phone app does nothing until it is paired with a Mac running Orbital,
through the relay. An App Store or Google Play reviewer has neither, so
the first public release would be rejected or sent back: Apple's guideline
2.1 asks for the whole app to be reviewable, and accepts a demo mode for
apps that depend on hardware the reviewer does not have; Google Play's
"App access" asks for the same in its own words. A video with notes alone
is often not enough for Apple.

## The idea

A "Try without a Mac" link on the pairing screen opens the app on local
data, with no network:

- a handful of sessions covering the states that matter: one running, one
  needing input (a question, a permission), one stopped at a harness gate,
  one ended;
- answering, approving a gate, sending a message and starting a session
  all work and change what the screen shows, but nothing leaves the
  phone;
- a plain line says this is a demo, with a way back to real pairing.

The swap happens below the UI: `web/src/mobile` gets a fake transport in
place of the relay client. It answers the allowlisted API calls from
fixtures and replays a few events on the WS topics. The server, the relay
and the desktop do not change.

The demo has to ship in the release build, because review uses the
release build. That also makes it useful to people who install the phone
app before the desktop app, and for store screenshots.

## Ruled out

- **A hosted demo Mac paired with the reviewer.** A reviewer could start
  Claude sessions on the owner's machine and subscription, and pairing only
  works by scanning the Mac's QR code (pasting a code is dev-build only).
- **Only a video and review notes.** Cheapest, but likely to cost a
  rejection round with Apple.

## Open questions

- Which fixtures to use, and whether they come from the canvas's mobile
  artboards so the demo matches the design.
- Whether push notifications are shown in the demo (a local notification
  for the session that needs input) or left out.
