# Relay

## Version

A change here that alters the image — a fix or a feature — gets a version
bump: `version` in `relay/package.json`. It tags the image GitHub Actions
pushes to GHCR (`.github/workflows/relay-image.yml`); until it is bumped,
the version tag is overwritten on every push.

Propose patch, minor or major and ask, as the root `CLAUDE.md` → Versions
says. Major is for a change a Mac or phone already in use cannot talk to.
