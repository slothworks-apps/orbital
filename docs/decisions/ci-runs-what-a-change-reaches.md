---
id: ci-runs-what-a-change-reaches
title: CI runs what a change reaches, and main requires one check that sums it up
type: adr
status: in-force
tags:
  - release
  - security
related:
  - main-changes-through-pull-requests
---
# CI runs what a change reaches, and main requires one check that sums it up

## Context

The repository is public, so `main` has to be what CI has checked. CI
typechecked, linted and tested each workspace, but nothing built what
ships: an `electron-builder.yml` that names a file the build stopped
making, or a Dockerfile that no longer copies what the relay needs, only
broke at release. And every pull request ran every job, a docs edit as
much as a lockfile change.

## Decision

`ci.yml` starts with a `changes` job that reads the changed paths
(`dorny/paths-filter`) and every other job runs only when its paths
changed:

- `check (<workspace>)`, typecheck, lint and tests, for the workspaces a
  change reaches. `shared/` and the root files (lockfile, lint config, the
  workflow itself) reach all of them. server's tests also start a relay,
  web reads `desktop/package.json`, and mobile builds from web.
- `build (desktop)` packages `Orbital.app` on a macOS runner the way the
  release does, ad-hoc signed and not notarized, so it needs no secrets and
  runs for a fork's pull request too.
- `build (relay)` builds the relay's Docker image without pushing it.
- `docs` runs `atlas validate` when `docs/` changes.
- `dependencies` runs GitHub's dependency review when a `package.json`, the
  lockfile or a workflow changes, and refuses a dependency or an action
  with a known vulnerability.
- `secrets` runs gitleaks over every commit of the pull request, with the
  same `.gitleaks.toml` as the pre-commit hook.

A skipped job reports no check, and a required check that never reports
blocks the merge. So the last job, `ci passed`, needs all the others, runs
always, and fails only when one of them failed or was cancelled. The
ruleset on `main` requires `ci passed` and `attribution`, not the
individual jobs.

## Alternatives

- **`paths` on the workflow's trigger.** The whole workflow is skipped, so
  its required checks never report and the pull request waits forever.
- **Every job required by name.** The list in the ruleset has to follow
  every job that is added or renamed, and a skipped matrix job reports
  under its unexpanded name.
- **Building the phone apps.** An Android or iOS build needs the SDKs and,
  for iOS, a macOS runner with CocoaPods, for the little the web build and
  `test:bundle` do not already catch. Left out for now.
- **CodeQL.** Not switched on in this change; it is a repository setting,
  not part of the workflow.
