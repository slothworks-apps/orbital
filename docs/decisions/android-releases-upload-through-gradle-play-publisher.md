---
id: android-releases-upload-through-gradle-play-publisher
title: Android releases upload to Google Play through Gradle Play Publisher
status: in-force
type: adr
domain: remote
related:
  - build-the-android-app
tags:
  - mobile
  - release
---
# Android releases upload to Google Play through Gradle Play Publisher

## The problem

`npm run ios:release` archives the iOS app and uploads it to TestFlight in
one command. The Android side stopped at a bundle on disk, and every release
needed the Play Console in a browser to upload it.

## The decision

The upload goes through the Google Play Developer API from Gradle, with
[Gradle Play Publisher](https://github.com/Triple-T/gradle-play-publisher)
(`com.github.triplet.play`). `npm run android:release` builds the bundle and
uploads it to the **Internal testing** track, rolled out at once;
`npm run android:bundle` keeps the build-only path. A service account's JSON
key in the git-ignored `secrets/` authorises it. Production releases stay
hand-made in the Console.

## Why

- It lives where the build already is: one Gradle task after
  `bundleRelease`, reading the same signing setup, with no second toolchain.
- fastlane `supply` does the same upload but brings Ruby and a Gemfile into
  a repository that has neither, for one command.
- A script on the `googleapis` client would be ours to keep working against
  the API's edit-and-commit flow; the plugin already does that.
- Internal testing needs no review, so the command can finish the release;
  production, with its review and staged rollout, deserves a person.

## Consequences

- `secrets/play-service-account.json` joins the upload key; without it the
  upload stops with "No Play service account", the bundle build still works.
- The versioned copy `orbital-<versionName>.aab` is now a copy, not a
  rename: the plugin reads the bundle at Gradle's own path.
- A draft app (never rolled out) takes only draft releases; `-PplayStatus=draft`
  covers it (runbook build-the-android-app).
