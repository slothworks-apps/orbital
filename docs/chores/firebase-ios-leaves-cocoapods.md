---
id: firebase-ios-leaves-cocoapods
title: Firebase's iOS SDK leaves CocoaPods while ML Kit stays on it
status: backlog
type: chore
domain: remote
related:
  - 2026-10-05-ios-app-design
  - build-the-ios-app
tags:
  - mobile
  - ios
---
# Firebase's iOS SDK leaves CocoaPods while ML Kit stays on it

The iOS project takes its native dependencies through CocoaPods because
Google ships ML Kit, which `@capacitor-mlkit/barcode-scanning` needs, only
as a pod. `pod install` warns that Firebase publishes no new pods after
October 2026; the versions in use keep installing and working.

Nothing breaks today. It bites when `@capacitor-firebase/messaging` next
needs a Firebase newer than the last pod. Then one of:

- move the project to Swift Package Manager and replace the scanner — the
  plugin's README points at a Capawesome scanner built on AVFoundation and
  Vision, which also ends the simulator problem ([[build-the-ios-app]]);
- or keep CocoaPods for ML Kit and take Firebase through SPM beside it, if
  Capacitor's CLI supports the mix by then.
