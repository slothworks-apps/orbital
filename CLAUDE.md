# Orbital

Orbital is a local web app that shows your Claude Code sessions as a 2D
space map: sessions are planets, subagents are orbiting moons. Its reason
to exist is multitasking — when several projects and tasks run at once, it
cuts the overhead of tracking them: one map shows what is running, what
needs your input and what has ended, and a session can be opened, continued
or spawned directly from the browser (through the Claude Agent SDK, billed
to your subscription the same way the CLI is).

Three npm workspaces:

- `server/` — Fastify API + WebSocket. Watches `~/.claude` for the CLI's
  session transcripts (an undocumented, unstable format that can break on
  CLI updates) and runs the sessions Orbital spawns itself. SQLite via
  drizzle. Binds to `127.0.0.1` only; there is no authentication.
- `web/` — React + Vite frontend; the map renders with react-three-fiber,
  state lives in zustand.
- `desktop/` — Electron shell (macOS arm64): one window and native
  notifications. The main process is thin — it forks the bundled server or
  attaches to a running dev server, and every decision lives in pure
  functions under `desktop/src/lib` that vitest exercises without launching
  Electron.

### Desktop version

The desktop app's version is `version` in `desktop/package.json`, and it
names the DMG. The DMG bundles `server/` and `web/` as well, so a change to
any of the three workspaces changes what ships. When you finish such a
change, ask whether to bump the version, and propose patch, minor or major.
Ask on your own, before you report the work as done. Do not bump it without
an answer.

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

The design lives in Claude Design, not in this repository. Always read it
from there, through the `DesignSync` MCP:

```
projectId  df77470e-1384-436c-8b25-5e01acfc497f
canvas     https://claude.ai/design/p/df77470e-1384-436c-8b25-5e01acfc497f?file=Orbital.dc.html
```

`list_files` for the file list, `get_file` for one file. `Orbital.dc.html` is
the main canvas; artboards are `<div id="1a">`, `<div id="2b">` and so on, and
the id is how they are referred to in conversation ("section 2a"). The project
also holds `Planet Variants.dc.html` and several `Feature - *.dc.html`.

Two things that will otherwise waste your time:

- **Any export committed under `design/` is stale.** New artboards are added to
  the canvas and never re-exported. Do not read the local copy, do not answer a
  design question from it, and do not conclude an artboard does not exist
  because it is missing there.
- **Only the MCP works.** `WebFetch` on the canvas URL returns 403, and the
  Claude in Chrome extension is often not connected. If a `DesignSync` read
  fails on authorization, ask the user to run `/design-login`.

`get_file` returns a JSON envelope whose `content` is escaped; unescape `\n`
before reading it, and grep for the artboard id rather than paging the whole
file — the canvas is ~240 KB.

**`get_file` truncates at 256 KiB, silently.** Before writing a canvas file
back, check that what you read ends in `</html>`. If it does not, or if it is
exactly 262144 bytes, you have half a file — writing it back destroys
everything past the cut, and there is no version history in Claude Design to
undo it with. `Orbital.dc.html` sits on that limit, so it cannot be
round-tripped through `write_files` at all. This happened: 2026-09-22, the
tail of artboard 1e and whatever followed it.

Verifying a substitution by reversing it proves nothing about truncation —
both sides are already cut. Verify against the closing tag.
