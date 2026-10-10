---
id: dependabot-opens-security-updates-only
title: Dependabot opens security updates only, and Agent SDK updates
status: in-force
type: adr
tags:
  - ci
  - dependencies
---
# Dependabot opens security updates only, and Agent SDK updates

## The problem

Dependabot ran monthly version updates for npm, GitHub Actions and the
relay's Docker image, grouped into a minor-and-patch pull request and a
majors pull request. The grouping made the majors PR unmergeable as a unit:
in October 2026 it bundled six majors, one of which (`marked` 18) cannot land
while `@tiptap/markdown` asks for `marked` 17, so the whole PR failed CI and
had to be redone by hand. A stream of routine bumps to review costs more
attention than it saves.

## The decision

`.github/dependabot.yml` keeps every ecosystem but sets
`open-pull-requests-limit: 0`, which turns version updates off. Dependabot
security updates stay on in the repository settings and still open a pull
request whenever an advisory reaches a dependency, along with the alert.

Upgrades without a security reason are taken by hand, when a new version
brings something Orbital needs or an old one stops working.

One exception: `@anthropic-ai/claude-agent-sdk` keeps weekly version
updates. It tracks the Claude Code CLI that Orbital's sessions run on, and
falling behind it is how new CLI features and transcript changes stop
working.

The exception needs two npm entries. `allow` and `ignore` narrow security
updates as well as version updates, so an `allow` naming only the SDK on the
one npm entry would stop security fixes for every other package. Security
updates read only an entry without `target-branch`; the SDK's entry sets
`target-branch: main` so its `allow` touches version updates alone, and the
plain entry, with `open-pull-requests-limit: 0`, carries security updates for
everything.

## What was ruled out

- **Keep monthly updates, ignore the troublesome packages.** Fixes this
  month's `marked`, not the next one, and still delivers a PR a month.
- **A scheduled workflow that bumps the SDK and opens a PR.** A pull request
  opened with the workflow's own token does not trigger CI, so it would need
  a personal token or an app as well; Dependabot needs neither.
- **Delete `dependabot.yml`.** Security updates would keep working, but the
  file is where the decision is visible to the next person who wonders why
  no update PRs arrive.

## Consequences

Dependencies drift until someone upgrades them. A security fix that needs a
major version arrives as a security PR like any other and gets reviewed on
its own.
