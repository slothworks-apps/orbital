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

Six npm workspaces:

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
- `mobile/` — the Capacitor shell (Android) around `web/src/mobile`; no
  application logic of its own.

### Desktop version

The desktop app's version is `version` in `desktop/package.json`, and it
names the DMG. The DMG bundles `server/` and `web/` as well, so a change to
any of those three workspaces changes what ships. When you finish such a
change, ask whether to bump the version, and propose patch, minor or major.
Ask on your own, before you report the work as done. Do not bump it without
an answer.

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
