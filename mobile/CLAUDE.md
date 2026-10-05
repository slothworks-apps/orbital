# Mobile

## Version

The phone app's version is `versionName` in
`mobile/android/app/build.gradle`; `versionCode` next to it goes up by one
with every bump, since Android refuses to install a build whose code is not
higher than the installed one. `version` in `mobile/package.json` is not
what ships.

iOS ships the same app and carries the same version: `scripts/ios-release.sh`
passes `versionName` and `versionCode` to Xcode as `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION`, and App Store Connect, like Play, refuses a build
number it has seen. So a bump is one edit, in `build.gradle`, and reaches
both platforms. The two values in the Xcode project only label builds run
from Xcode.

`mobile/CHANGELOG.md` covers both platforms; a line that is true of one only
says which.

The app is a shell around `web/src/mobile`, so a fix or a feature there
bumps it as well as one here. Propose patch, minor or major and ask, as the
root `CLAUDE.md` → Versions says.
