---
id: main-changes-through-pull-requests
title: Main changes through pull requests, guarded by hooks in the repository
type: adr
status: in-force
tags:
  - release
  - security
---
# Main changes through pull requests, guarded by hooks in the repository

## Context

Until Orbital went public, every change, a version bump included, was
committed to `main` and pushed straight to it. A public repository needs
`main` to be what CI has checked, and a secret pushed once to a public
remote has to be treated as leaked, however fast it is removed.

## Decision

`main` changes only through pull requests. Two git hooks in `.githooks/`
hold the line locally, and `npm install` points `core.hooksPath` at them
through the root `prepare` script:

- `pre-commit` refuses a commit while `main` is checked out, then runs
  `gitleaks git --pre-commit --staged`. Made-up secrets the tests need are
  allowed in `.gitleaks.toml` by path and value together, so a real secret
  pasted into a test is still caught.
- `pre-push` refuses a push whose target is `refs/heads/main`.

Without gitleaks installed the hook warns and commits anyway: a contributor
should not be locked out by a missing tool, and GitHub's secret scanning
catches what reaches the remote. The ruleset on `main` (see the going-public
plan) enforces the same rule on GitHub, where `--no-verify` does not reach.

## Alternatives

- **husky or lefthook.** A dependency to install a hook path git already
  supports. Two short shell scripts do not need a manager.
- **Ruleset alone.** It stops the push but only after the commit exists,
  and it does not scan for secrets before they leave the machine.
- **gitleaks in CI.** It sees the secret only once it is pushed; and the
  official action needs a paid licence for an organisation's repository.
