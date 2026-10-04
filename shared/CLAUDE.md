# Shared

## Version

`shared/` has no version of its own: it is bundled into everything that
ships. A fix or a feature here reaches the desktop DMG
(`desktop/package.json`), the relay image (`relay/package.json`) and the
Android app (`mobile/android/app/build.gradle`) — whichever of them import
what changed. Ask about each one it reaches, with a proposal of patch,
minor or major, as the root `CLAUDE.md` → Versions says.
