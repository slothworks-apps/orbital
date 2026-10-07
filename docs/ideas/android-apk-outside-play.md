---
id: android-apk-outside-play
title: Ship the Android app as an APK outside Google Play
status: backlog
type: idea
domain: mobile
related:
  - store-review-without-a-mac
  - ota-updates-through-beam
tags:
  - mobile
  - release
---
# Ship the Android app as an APK outside Google Play

Android installs an APK from anywhere once the user allows it, and push
notifications through FCM work the same. A public Android release can
therefore skip Google Play and its review: an APK attached to a GitHub
release, with over-the-air updates for the web layer
([[ota-updates-through-beam]]). Play can be added later.

iOS has no such path for the public: outside the App Store there is only
TestFlight (still reviewed, builds expire after 90 days), ad hoc
distribution (registered devices only) and, in the EU only, notarized
alternative marketplaces.

## Signing decides whether Play can come later

The key in `secrets/` is Play's **upload key**. Play re-signs the app with
its own key (Play App Signing, `docs/ops/build-the-android-app.md`), so an
APK signed with the upload key and the app from Play carry different
signatures. A user of one cannot update to the other; switching means
uninstalling and pairing again.

Two ways out, to choose before the first public APK:

- **Ship the universal APK Play Console builds** from the uploaded bundle.
  It carries Google's signature, so APK users can later move to Play by an
  ordinary update. Recommended.
- **Sign the APK with our own key** and accept that Play, if it comes,
  is a separate install.

Whichever key signs the public APK can never change for its users. If it
is ours, losing it ends updates for everyone who installed the APK —
Google can reset an upload key only for Play.

## Telling users a new native version is out

An APK user gets no update from a store. When Beam holds a bundle that
needs a newer native version (`minNativeVersion` above the installed one),
the app says a new version is available and links the download.

## Open questions

- Whether Google's developer verification for apps installed outside Play
  (rolling out from 2026, worldwide in 2027) asks for anything the Play
  Console account does not already cover.
