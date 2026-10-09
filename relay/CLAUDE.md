# Relay

## Version

A change here that alters the image — a fix or a feature — gets a version
bump: `version` in `relay/package.json`. The image is built and pushed to
GHCR only when that version goes up (`.github/workflows/release.yml`), tagged
with it; a change merged without a bump never reaches the image.

Propose patch, minor or major and ask, as the root `CLAUDE.md` → Versions
says. Major is for a change a Mac or phone already in use cannot talk to.
