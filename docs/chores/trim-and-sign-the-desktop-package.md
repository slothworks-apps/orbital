---
id: trim-and-sign-the-desktop-package
title: Packaging follow-ups for the desktop app
type: chore
status: backlog
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - run-the-desktop-app
tags:
  - desktop
  - electron
  - packaging
---
# Packaging follow-ups for the desktop app

The unsigned arm64 DMG builds, launches and serves. These four jobs were left
out of that work deliberately: none of them blocks shipping to the two users
the app exists for, and the first one needs a decision rather than a cleanup.

## About 30 MB of the app is unreachable

`desktop/package.json` lists `better-sqlite3` and `@anthropic-ai/claude-agent-sdk`
as `dependencies`, and that list is what electron-builder packs. So the SDK is
copied into `app.asar` and better-sqlite3 into `app.asar.unpacked` — all eight
of its prebuilds, plus `deps/` and `src/` — while nothing ever loads either
copy: the main process imports neither, and the forked server resolves both
from `Resources/server/node_modules/`, where `extraResources` puts a filtered
copy carrying only the one prebuild that runs. Roughly 9% of the app, and the
same again off the DMG. Removing it also makes the `asarUnpack` line vestigial,
because that line exists to keep the native binding out of the archive it would
then no longer be in. Two entangled changes to the shape of the artifact, so
the call belongs in an `adr` rather than in a quiet commit.

## `electron-builder` still floats on a caret

`electron` is pinned exactly — electron-builder refuses a range, because it
downloads binaries for one specific release. The tool that decides what bytes
end up in the artifact deserves the same treatment for the same reason: a
packaging tool that can change under you between two builds of the same commit
makes every "it built yesterday" report unfalsifiable.

## `desktop/package.json` has no `author`

electron-builder warns about it on every build and falls back to the product
name. Harmless while the DMG is unsigned and handed over directly. It stops
being harmless at the signing and Homebrew-cask steps, where the field feeds
real metadata — so add it before starting those, not during.

## Signing, notarization, and then a cask

Spec §4 steps 2 and 3, in that order and not the other. Signing and
notarization go through the Apple Developer account that already exists, and
electron-builder has both built in — configuration, not rearchitecture, and
nothing in the design changes. The Homebrew cask comes after, pointing at a
notarized DMG in GitHub Releases; over an unsigned app it would only deliver
the same quarantine prompt through a longer pipe. Note that the current build
sets `mac.identity: null` on purpose: left unset, electron-builder finds this
machine's *Apple Development* certificate and signs with it, which is not a
distribution identity and fails on someone else's Mac in a way that is much
harder to read than ordinary quarantine.
