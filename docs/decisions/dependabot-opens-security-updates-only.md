---
id: dependabot-opens-security-updates-only
title: Dependabot opens security updates only
status: in-force
type: adr
tags:
  - ci
  - dependencies
---
# Dependabot opens security updates only

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

## What was ruled out

- **Keep monthly updates, ignore the troublesome packages.** Fixes this
  month's `marked`, not the next one, and still delivers a PR a month.
- **Delete `dependabot.yml`.** Security updates would keep working, but the
  file is where the decision is visible to the next person who wonders why
  no update PRs arrive.

## Consequences

Dependencies drift until someone upgrades them. A security fix that needs a
major version arrives as a security PR like any other and gets reviewed on
its own.
