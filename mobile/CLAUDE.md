# Mobile

## Versions

The phone has two versions (ADR
`the-phone-has-an-app-version-and-a-native-version`):

- **The app version**, `version` in `mobile/package.json`, is the code in
  `web/src/mobile`. It ships over the air as a signed bundle through Beam
  (runbook `ship-the-phone-over-the-air`). The app reads it for its `hello`
  to the Mac, the settings footer and the update prompt;
  `package-lock.json` repeats it. Every change that reaches the phone bumps
  it — here, in `web/src/mobile` and what it imports, or in `shared/`.
- **The native version**, `versionName` in `android/app/build.gradle`, is
  the shell. It goes up only for a change a bundle cannot carry: a native
  plugin, a permission, an `Info.plist` or manifest change, a Capacitor
  upgrade, a change to `capacitor.config.ts` (the config ships in the
  binary). Such a change ships through TestFlight and Play. `versionCode`
  next to it goes up by one with every native bump, since Android refuses a
  build whose code is not higher than the installed one, and App Store
  Connect a build number it has seen. `scripts/ios-release.sh` passes both
  to Xcode as `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`; the Xcode
  project repeats them for builds run from Xcode.

A native bump bumps the app version too; the app version is never below
the native one. `node scripts/check-versions.mjs` checks the copies and
that rule, and the `versions` job in CI runs it on every PR.

`mobile/CHANGELOG.md` is kept per app version and covers both platforms; a
line that is true of one only says which, and a line for a native change
says it needs the update from TestFlight or Google Play.

Propose patch, minor or major and ask, as the root `CLAUDE.md` → Versions
says.

## The updater

`@capgo/capacitor-updater` is pinned exactly; below 8.51.23 Android accepts
an unsigned bundle (ADR `an-ota-bundle-runs-only-if-signed-by-ci`). Only a
build made with `ORBITAL_MOBILE_RELEASE=1` (the root release scripts) turns
it on, and that build needs `ota-public-key.pem`; every other build
switches it off.
