---
id: a-changelog-per-shipped-app
title: A changelog per shipped app, not one for the repository
type: adr
status: in-force
tags:
  - release
---
# A changelog per shipped app, not one for the repository

## Context

The repository ships three things, each with its own version: the desktop
DMG, the relay image and the Android app (root `CLAUDE.md` → Versions).
They are bumped independently — the desktop moves several times a day,
the relay and the phone rarely. Orbital is going public and needs a record
of what changed in each release that a user can read.

## Decision

Each shipped app keeps its own `CHANGELOG.md` beside the file that holds
its version: `desktop/CHANGELOG.md`, `relay/CHANGELOG.md`,
`mobile/CHANGELOG.md`. The format is Keep a Changelog: newest first, an
`[Unreleased]` section filled as the work lands and renamed in the bump
commit. A change in `shared/` that reaches more than one app is written
into each of them, for that app's user. The agent keeps them as part of
the work; the rule is in the root `CLAUDE.md` → Changelogs.

The history before this decision was backfilled from the version-bump
commits: each version lists the commits between its bump and the previous
one that touch that app's paths.

## Alternatives

- **One changelog for the repository.** Three version sequences would
  interleave in one file, and a relay user would read through desktop
  releases to find theirs. Monorepo release tools (changesets,
  release-please, Lerna) keep one per independently versioned package for
  the same reason.
- **Generated from commit messages.** Commit subjects are written for
  developers and name files and refactors; the changelog is for users.
  Generation would also need a commit convention the repository does not
  enforce.
