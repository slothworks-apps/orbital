# Orbital

Orbital is a local web app that shows your Claude Code sessions as a 2D
space map: sessions are planets, subagents are orbiting moons. Its reason
to exist is multitasking — when several projects and tasks run at once, it
cuts the overhead of tracking them: one map shows what is running, what
needs your input and what has ended, and a session can be opened, continued
or spawned directly from the browser (through the Claude Agent SDK, billed
to your subscription the same way the CLI is).

`docs/why-orbital.md` holds what Orbital is for and the calm it keeps. Read
it before you design anything the user sees or hears — states, motion,
notifications, sound — and do not build what it rules out.

Seven npm workspaces:

- `shared/` — what the Mac, the relay and the phone agree on: keys,
  frames, the handshake, message shapes, and the notification rules.
- `server/` — Fastify API + WebSocket. Watches `~/.claude` for the CLI's
  session transcripts (an undocumented, unstable format that can break on
  CLI updates) and runs the sessions Orbital spawns itself. SQLite via
  drizzle. Binds to `127.0.0.1` only; requests to `/api` and `/ws` need the
  token from `<dataDir>/api-token`.
- `web/` — React + Vite frontend; the map renders with react-three-fiber,
  state lives in zustand.
- `desktop/` — Electron shell (macOS arm64): one window and native
  notifications. The main process is thin — it forks the bundled server or
  attaches to a running dev server, and every decision lives in pure
  functions under `desktop/src/lib` that vitest exercises without launching
  Electron.
- `relay/` — the blind relay between a Mac running Orbital and its paired
  phones. It is deployed on its own as a Docker image and sees only
  encrypted frames.
- `mobile/` — the Capacitor shells (Android and iOS) around `web/src/mobile`; no
  application logic of its own.
- `site/` — the public website at orbital.slothworks.io — Astro, static; its
  demos render components from `web/src` on demo data.

### Versions

Three things ship, and each carries its own version; the phone carries two:

| what ships | its version | changed by |
|---|---|---|
| the desktop DMG | `version` in `desktop/package.json` | `desktop/`, `server/`, `web/`, `shared/` |
| the relay image | `version` in `relay/package.json` | `relay/`, `shared/` |
| the phone app, over the air (Android and iOS) | `version` in `mobile/package.json` | `mobile/`, `web/src/mobile` and what it imports, `shared/` |
| the phone's native shell, through the stores | `versionName` in `mobile/android/app/build.gradle` | a native plugin, a permission, an `Info.plist` or manifest change, a Capacitor upgrade |

Every change that reaches the phone bumps its app version, which ships as a
signed bundle through Beam. Only a change the bundle cannot carry bumps the
native version too, and that is a store build; a native bump always bumps
the app version with it, which never falls below the native one
(`docs/ops/ship-the-phone-over-the-air.md`).

When you finish a change that alters what ships — a fix or a feature, not
a test, a comment or a document — ask whether to bump each version it
touches. Always propose one of patch, minor or major, with the reason:
patch for a fix, minor for a new feature, major for a change that breaks
what is already out there (a relay a shipped Mac or phone can no longer
talk to, say). Ask with AskUserQuestion, your proposal first. Ask on your
own, before you report the work as done. Do not bump without an answer.

Each workspace's `CLAUDE.md` says which of these versions its changes
reach.

The website has no version and no changelog. It is deployed straight from
`main` by `.github/workflows/site-deploy.yml`.

A phone bump is not one edit: the app version has a copy in
`package-lock.json`, and `versionName` and `versionCode` have copies in the
Xcode project; every copy changes with its source (`mobile/CLAUDE.md`). Run
`node scripts/check-versions.mjs` after a bump; the `versions` CI job runs
it on every PR and fails on a copy left behind. In a PR it also runs with
`--base`, which fails on a version lower than on `main` (either phone
version included), and on a new `versionName` without a higher
`versionCode`.

### Changelogs

Each of the three has its own changelog next to its version:
`desktop/CHANGELOG.md`, `relay/CHANGELOG.md`, `mobile/CHANGELOG.md`, in
the Keep a Changelog format. Keep them yourself; do not wait to be asked.

- A change that alters what ships gets a line under `## [Unreleased]` in
  the changelog of every app it reaches, in the same change. A change in
  `shared/` that reaches two apps gets a line in both, phrased for each.
- Write for the person using the app: what changed for them, in plain
  words, one line. No file names, no commit subjects, no refactors, tests
  or docs.
- When a version is bumped, rename `## [Unreleased]` to
  `## [<new version>] — <date>` and open an empty `## [Unreleased]` above
  it, in the bump commit.

### Branches

`main` changes only through pull requests. The hooks in `.githooks/`
(wired by `npm install`) refuse a commit on `main` and a push to it, and
scan every commit with gitleaks. Do the work on a branch, push the branch
and open a PR with `gh pr create`; a version bump goes into the same PR.
Do not pass `--no-verify` to get around a hook: if gitleaks flags a
stand-in value in a test, add it to `.gitleaks.toml`; if it flags a real
secret, take it out.

Commit messages and PR descriptions carry no attribution: no
`Co-authored-by` trailer at all, for a person or for Claude, and no
"Generated with" footer, even where a default or a reminder asks for one.
The `commit-msg` hook refuses such a message; the `Attribution` workflow
checks the same in every PR's commits and description.

Every PR gets a description and labels when it is opened — never
`--fill` alone, which leaves the body empty. The description says what
changes for the user and why, the phone decision, and any version bump.
Labels: `desktop`, `relay`, `mobile` for each app the change reaches (the
same mapping as Versions above), `site` for a change that reaches the
website (a change under `web/src` can reach it too, through its demos),
`ui` when it changes what the user sees, `ci` for workflows, hooks and
build scripts, plus one of `bug`, `enhancement` or `documentation`. If no
existing label fits, ask before creating one (`gh label list` shows them).

### Every feature has a phone answer

Orbital also runs on the phone: `mobile/` is the Capacitor shell around
`web/src/mobile`, and it reaches the server through `relay/` and the route
allowlist in `server/src/remote/allowlist.ts`. A route that is not on that
list does not exist for the phone.

So every feature gets a decision about the phone, made while designing it,
not after: build it for the phone too, leave the phone out on purpose, or
note how the change reaches the phone anyway (a route, a WS topic or a
shared component it uses). Write the decision into the feature's spec,
in its own section. When the phone is left out, say why, and if it is
worth doing later, write an `idea` for it.

A phone feature built on something new on the Mac must also work against
an older Mac, because the phone updates first. Gate it in `MAC_FEATURES`
(`mobile/CLAUDE.md` → A feature that needs a newer Mac).

`npm run dev` starts the server and the web app. The README covers run/test commands, billing
(`ANTHROPIC_API_KEY` is deleted from the server's environment on startup
unless `ORBITAL_USE_API_KEY=1`) and the `~/.claude` caveats.

<!-- atlas:begin 2026-09-16 -->
## Documentation

Documentation lives in `docs/` and every markdown file there carries
atlas frontmatter. `docs/CLAUDE.md` is the full rule: the fields, the
types, the statuses and the directory each type lives in. Read it before you
write, move or rename a document.

### Writing documents is part of the work

Do not wait to be asked for one. When something below happens, write the
document in the same change, before you report the work as done.

| what just happened | write |
|---|---|
| you chose one way over another, or ruled one out | `adr` |
| you agreed how something should work before building it | `spec` |
| the work needs more than a few steps | `plan` |
| you worked out how a part of the product behaves today | `domain` |
| you found a bug you are not fixing now | `fix` |
| you worked out the steps to run or repair something | `runbook` |

An answer that lives only in the chat is gone when the session ends. Check
first whether the document already exists and update that one instead of
writing a second. When the work a document describes is finished, set its
status.

```bash
atlas validate    # run this before you commit
```
<!-- atlas:end -->

A `plan` is not always needed: it exists to carry work across a gap — to
another session, another person, or a later date. When an agreed spec is
implemented immediately in the same stretch of work, the spec is the
requirements document and writing a plan first is overhead; skip it.

## Tests

Write tests only where they can catch a real regression, not by reflex.
A change is complete without a test unless it falls in the first list.

Worth testing:

- parsing, tokenizing and path/URL handling — anything with edge cases
- server routes, security boundaries, persistence
- pure logic that is hard to eyeball (layout math, geometry, state
  transitions)

Not worth testing:

- that React renders its props — labels, classNames, data-attributes
- exact styling values (px sizes, opacities, animation periods). These
  freeze the canvas into the suite and break on every design tweak;
  canvas fidelity is verified against Claude Design during the work
  itself, not pinned in tests.
- thin wrappers and glue with no branching

Rule of thumb: a test earns its place only if it can fail for some
reason other than someone deliberately changing the value it asserts.

## Visual design

The visual design is maintained outside this repository by the maintainer.
