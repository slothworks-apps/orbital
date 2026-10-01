---
id: desktop-follow-ups
title: Desktop wrapper — deferred code-level follow-ups
type: chore
status: backlog
domain: desktop
related:
  - 2026-09-16-electron-wrapper-design
  - trim-and-sign-the-desktop-package
  - 2026-10-01-mobile-remote-backend
tags:
  - desktop
  - server
---

# Desktop wrapper — deferred code-level follow-ups

Small findings the desktop-wrapper reviews surfaced and deliberately
deferred. None blocks anything; the first two are the ones to pick up
when their files are next open.

- **`sessionsFeed` retry machine is untested** (`desktop/src/lib/sessionsFeed.ts`)
  — the only branching logic under `desktop/src/lib` without a vitest
  suite; stubbable via `globalThis.WebSocket`.
- **Unbounded waits in the shell** (`desktop/src/main.ts`) — the
  `discardChild` exit-wait and `whenReady().then(start)` are unbounded and
  uncaught; the failure mode is a running app with no window and nothing
  said.
- **Probe timeout classified as refusal** (`desktop/src/lib/probe.ts`) — a
  foreign service slower than the 1 s probe gets forked onto; it fails
  loudly (EADDRINUSE dialog) rather than silently, hence deferred.
- **Quit during the initial health poll** — narrow race around the
  "Try again / Quit" dialog with no window open.
- **CLI override checks existence, not executability**
  (`server/src/runner/claudeCli.ts`) — a directory or non-executable file
  at `claude_executable_path` resolves as the CLI and fails only at spawn.
- **`parseClaudeVersionOutput` takes the first semver-ish token** anywhere
  in stdout; a stray dotted number could read as a version.
- **`claude_executable_path` applies at server boot only** — the Settings
  field says so honestly; re-resolving on PATCH (or a restart action
  beside the field) needs its own decision. The desktop missing-CLI dialog
  already restarts the child after writing the key; the Settings field
  does not.
- **`routes.test.ts` `claude_code_version` case** compares against the SDK
  manifest and only agrees while the `darwin-arm64` optional dep is
  installed; on a host with only a PATH `claude` it fails (latent — no CI
  in this repo today).
- **Boot can serialise the login-shell and `--version` timeouts** (~8 s
  worst case) before `listen()`; the desktop's 15 s health poll absorbs
  it.
- **Orphaned forked server** (`desktop/src/main.ts`) — only `before-quit`
  kills the child, so a force-quit or crash of the main process leaves it
  running. The next launch attaches to it, so orphans do not multiply.
  From [[resource-usage-pass-2026-09-24]].
- **Notification polish**: empty `session_failed` message drops the
  notification (pinned by test); the click handler has no
  `isDestroyed()`/`isMinimized()` guard; a dead `?? message` fallback in
  `notifications.ts`.
- ~~**Docs drift**: runbook says `npm run dev:desktop`, README says
  `npm run dev -w desktop` (same script).~~ — **fixed 2026-09-22, and it had
  stopped being cosmetic.** Once the dogfood/dev split moved `npm run dev` to
  4838, `dev:desktop` (which sets `ORBITAL_PORT`) and a bare
  `npm run dev -w desktop` (which does not) stopped being the same script: the
  bare form probes 4737 and attaches to the *dogfood* instance. README and the
  runbook also both still claimed `npm run dev` serves on 4737.
- **`ORBITAL_VERSION` is not passed to the forked server.** The mobile
  remote's `hello` handshake (`server/src/remote/`) reports
  `server: 'dev'` because nothing sets that env var for the child process
  `desktop/src/main.ts` forks. Pass the desktop app's own `version` from
  `desktop/package.json` through so a paired phone can tell which build
  of Orbital it is talking to.
