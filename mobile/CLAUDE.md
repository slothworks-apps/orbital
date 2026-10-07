# Mobile

## Version

The phone app's version is `versionName` in
`mobile/android/app/build.gradle`; `versionCode` next to it goes up by one
with every bump, since Android refuses to install a build whose code is not
higher than the installed one.

iOS ships the same app and carries the same version: `scripts/ios-release.sh`
passes `versionName` and `versionCode` to Xcode as `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION`, and App Store Connect, like Play, refuses a build
number it has seen.

Three copies follow `build.gradle` and a bump changes them too: `version`
in `mobile/package.json` (the app reads it for its `hello` to the Mac and
the settings footer; `package-lock.json` repeats it), and
`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in
`ios/App/App.xcodeproj/project.pbxproj`, which label builds run from Xcode.
`node scripts/check-versions.mjs` checks they agree, and the `versions` job
in CI runs it on every PR.

`mobile/CHANGELOG.md` covers both platforms; a line that is true of one only
says which.

The app is a shell around `web/src/mobile`, so a fix or a feature there
bumps it as well as one here. Propose patch, minor or major and ask, as the
root `CLAUDE.md` → Versions says.
