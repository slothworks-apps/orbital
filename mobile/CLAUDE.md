# Mobile

## Version

The Android app's version is `versionName` in
`mobile/android/app/build.gradle`; `versionCode` next to it goes up by one
with every bump, since Android refuses to install a build whose code is not
higher than the installed one. `version` in `mobile/package.json` is not
what ships.

The app is a shell around `web/src/mobile`, so a fix or a feature there
bumps it as well as one here. Propose patch, minor or major and ask, as the
root `CLAUDE.md` → Versions says.
