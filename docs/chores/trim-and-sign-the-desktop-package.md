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

The unsigned arm64 DMG builds, launches and serves. These jobs were left
out of that work deliberately: none of them blocks shipping to the two users
the app exists for.

## ~~About 30 MB of the app is unreachable~~ — done

`desktop/package.json` listed `better-sqlite3` and `@anthropic-ai/claude-agent-sdk`
as `dependencies`, and that list is what electron-builder packed. So the SDK
was copied into `app.asar` and better-sqlite3 into `app.asar.unpacked` — all
eight of its prebuilds, plus `deps/` and `src/` — while nothing ever loaded
either copy: the main process imports neither, and the forked server resolves
both from `Resources/server/node_modules/`, where `extraResources` puts a
filtered copy carrying only the one prebuild that runs.

Before touching anything, the open question was whether electron-builder's
`install-app-deps` step (it runs `@electron/rebuild` unconditionally) was
rebuilding the root `node_modules/better-sqlite3` prebuild against Electron's
ABI — in which case deleting the `dependencies` entry could silently swap a
working rebuilt binary for a stock one that doesn't load under
`utilityProcess`. It does not: `better-sqlite3` builds against `NAPI_VERSION`
10, which is ABI-stable across Node and Electron, so its single
`prebuilds/darwin-arm64.node` loads unmodified under either runtime.
`@electron/rebuild` does run every build (`.forge-meta` / `build/Release`
appear under the root package), but never emits a replacement `.node` —
better-sqlite3's own loader (`lib/binding.js`) checks `prebuilds/` before it
would ever look in `build/Release` — and the prebuild's sha256 was byte-for-byte
identical (`98e0e8ac…`) before and after a full `desktop:release` run. The copy
`extraResources` ships was always, and remains, the stock npm prebuild.

The `dependencies` entries are gone from `desktop/package.json`, and the
`asarUnpack` line in `desktop/electron-builder.yml` went with them — it
existed only to keep the native binding out of an archive it no longer enters.
`app.asar` now contains only `dist/` and `package.json`; there is no
`app.asar.unpacked` at all. Measured: `Orbital.app` 340M → 309M, the DMG
140M → 128M. Verified by launching the packaged binary headlessly against a
fresh `ORBITAL_DATA_DIR` (`/api/health` returns 200 after migrations run,
confirming better-sqlite3 loads and works) and confirming clean shutdown on
SIGTERM.

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

The build no longer uses `null`: it uses `"-"` (ad-hoc), because the
unsigned bundle could not get notification permission. See ADR
`desktop-app-is-ad-hoc-signed`. The Developer ID step replaces `"-"` with the
real identity.
