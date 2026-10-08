---
id: 2026-10-08-mcpjson-approval-design
title: A project's .mcp.json servers run only once the user has approved them
status: active
type: spec
domain: sessions
related:
  - unapproved-mcp-json-servers-start-in-orbital-sessions
  - mcp-config-is-written-by-the-cli-in-private-scopes
  - 2026-10-01-mcp-servers-in-the-session-design
  - 2026-10-08-release-roadmap
  - phone-views-an-mcpjson-server-file
tags:
  - mcp
  - security
  - server
  - mobile
---
# A project's .mcp.json servers run only once approved

## Problem

A repository's `.mcp.json` names commands to start as MCP servers. The CLI
asks before it starts one it has not been told about; an Orbital session
does not, because the SDK starts every server nobody has turned down
([[unapproved-mcp-json-servers-start-in-orbital-sessions]]). Opening a
session in a freshly cloned repository runs whatever that repository
chose, with no prompt. Orbital is about to go to testers who expect it to
be at least as careful as the CLI.

## What was established (spike, 2026-10-08, SDK 0.3.287 / CLI 2.1.287)

- `settings: { disabledMcpjsonServers: [...] }` passed to `query()` keeps
  those servers from starting. Flag tier, in memory, nothing written.
- A decision in `disabledMcpjsonServers` is honoured from any source; an
  allowlist (`enabledMcpjsonServers`) does not keep other servers out, and
  `enableAllProjectMcpServers: false` is treated as "undecided".
- The flag-tier `disabledMcpjsonServers` wins over an approval of the same
  name in `.claude/settings.local.json`, in the user `settings.json`, in
  the project entry of `.claude.json`, and over
  `enableAllProjectMcpServers: true` (marker-file check, 2026-10-08). So
  rule 4 can keep out a server the CLI still counts as approved.
- The CLI now keeps a project's decisions in
  `<project>/.claude/settings.local.json` (it moves them there from the
  project entry of `~/.claude.json` on start).
- No `claude mcp` subcommand records an approval; only the interactive
  prompt does. `claude mcp reset-project-choices` clears them.
- A server kept out at start cannot be brought into a running session; an
  approval takes effect on the session's next start.
- `strictMcpConfig` is not a barrier (the in-session toggle starts servers
  it left out) and drops user and local servers. Not used.

## Behaviour

**Undecided** means: named in the project's `.mcp.json`, in neither
`enabledMcpjsonServers` nor `disabledMcpjsonServers` of any of the user
settings (`settings.json` in the session's Claude directory), the
project's `.claude/settings.json`, its `.claude/settings.local.json` or the
project entry of that directory's `.claude.json`, and
`enableAllProjectMcpServers` is not `true` in any of them.

1. **Every start keeps undecided servers out.** `Runner.start` is the one
   place all nine start paths go through (new session, revive, rewind,
   limit-wait continue, harness continuation, clear, the `spawn_session`
   tool, the harness interview, the MCP restart). It reads the undecided
   servers for the session's `cwd` and passes them as
   `settings.disabledMcpjsonServers`. Nothing that starts a session without
   a person at the keyboard can run an unapproved server.
2. **A new session started by the user asks first**, on the desktop and on
   the phone. Before the launch, the client learns which servers are
   undecided and, if there are any, asks once for all of them: each
   server's name and the command it would run, and per server *Allow* or
   *Don't allow*. The launch goes ahead with the answers; closing the
   question cancels the launch. A project with no undecided servers
   launches exactly as today, with no extra step.
3. **The answer is recorded where the CLI keeps it**, in
   `<cwd>/.claude/settings.local.json`: the server's name is added to
   `enabledMcpjsonServers` or `disabledMcpjsonServers` (and removed from
   the other). The terminal and Orbital then agree, and the CLI does not
   ask again. Every other key in the file is kept as it was.
4. **A changed command is a new question.** The CLI keys its decisions by
   name only, so a `git pull` that changes the command of an allowed server
   would run the new command unasked. Orbital keeps its own fingerprint of
   each entry it allowed (decided 2026-10-08, canvas 47e "a changed command
   counts as a new server"): a hash of the server's whole `.mcp.json` entry
   — `type`, `command`, `args`, `url`, `env`, `headers` — keyed by the
   project's real path and the server's name, in Orbital's database. A
   server that is allowed but whose entry no longer matches the fingerprint
   counts as undecided again: kept out at start and asked about on the next
   new session. A server allowed in a terminal has no fingerprint, and the
   CLI's decision stands. A server turned down stays turned down whatever
   its command. The terminal keeps running a changed command unasked; that
   is the CLI's behaviour, not Orbital's.
5. **Revives and the other paths never ask.** A server added to
   `.mcp.json` after a session started stays out of it until the user
   decides, which happens on the next new session in that project. A
   question in the middle of sending a message would interrupt the one
   thing the user is doing; keeping the server out is the safe answer, and
   the MCP dialog of that session simply does not list it.

## Server

- `server/src/mcp/mcpjson.ts`: `undecidedServers(cwd, claudeDir)` reads
  `.mcp.json` and the four decision sources above, and returns
  `{ name, command, args, source, file? }[]` (the command and args as written, for the
  question to show). A missing or unreadable file counts as empty; an
  unreadable `.mcp.json` means no servers. `recordDecisions(cwd,
  { allow, deny })` merges into `.claude/settings.local.json`, creating the
  directory and file when needed, and writes atomically (temp file and
  rename).
- `Runner.start` adds `disabledMcpjsonServers` to the `settings` option it
  already builds, for the undecided servers at start time.
- `GET /api/mcpjson?cwd=<path>&claudeDirId=<id>` → `{ undecided: [...] }`.
- `POST /api/sessions` takes an optional `mcpjson: { allow: string[], deny:
  string[] }`. When present, the decisions are recorded before the launch.
  When absent, the launch behaves as rule 1: undecided servers are kept
  out. So a client that predates this change (a phone already in testers'
  hands) still launches, safely, without being asked.
- Each undecided server also carries what the canvas labels it with
  (47e "Source label"), read from the command, not from `.mcp.json`:
  `source` is `npm` / `pypi` (a package runner: `npx`, `bunx`, `pnpm dlx`,
  `uvx`, `pipx run`), `docker`, `file` (a path inside the project:
  `./…`, `../…` that resolves inside it, or an absolute path under it,
  including as the first argument of an interpreter such as `node`,
  `python`, `bash`, `sh`, `deno run`, `bun`), `url` (an `http`/`sse`
  server) or `program` (anything else). For `file`, `file` is the path
  relative to the project, for *View file*.
- Fingerprints (rule 4) live in Orbital's database, table
  `mcpjson_approvals` (project real path, server name, entry hash).
  `recordDecisions` writes a fingerprint for every allowed server and
  deletes it for every denied one; `undecidedServers` counts an allowed
  server whose entry hash differs from its fingerprint as undecided, also
  under `enableAllProjectMcpServers: true` (a fingerprint exists only
  because the user allowed that server through Orbital, and the flag tier
  still keeps it out). The entry is hashed when the answer is recorded.
- Both routes go on the phone allowlist (`server/src/remote/allowlist.ts`).
  `GET /api/mcpjson/file` (§ Clients, *View file*) does not: the phone
  does not use it yet.
- ADR [[mcp-config-is-written-by-the-cli-in-private-scopes]] is amended:
  Orbital writes these two keys of `.claude/settings.local.json` itself,
  because the CLI offers no command that does, and nothing else in that
  file.

## Clients

- **Desktop** (`web/src/panels/NewSessionDialog.tsx` → store
  `launchSession`): before `api.createSession`, call `GET /api/mcpjson`;
  with undecided servers, show the question; launch with the answers.
- **Phone** (`web/src/mobile/NewSessionScreen.tsx`): the same, through the
  relay.
- The canvas is `Feature - MCP approval.dc.html` in Claude Design:
  47a/47b desktop (the New session dialog's content swapped in the same
  shell), 47c/47d phone (a sheet over the dimmed form), 47e parts and
  states; the project-file treatment is variant 2d. Where the canvas and
  this spec disagree, the spec's rules 1–5 win; the canvas's "can be
  switched on later in the MCP dialog" is not built now
  ([[mcpjson-decisions-in-the-mcp-dialog]]).
- *View file* opens the file in the read-only file viewer on the desktop.
  The phone shows the row without it for now: its file screen reads
  through an open session, and there is none yet
  ([[phone-views-an-mcpjson-server-file]]). There is no session to read it through yet, so it
  reads through `GET /api/mcpjson/file?cwd=<path>&server=<name>`: the one
  file `.mcp.json` names for that server, confined to the project like
  every other read, never an arbitrary path. The viewer is opened by the
  dialog rather than through `ui.fileViewer`, which belongs to the
  selected session and is mirrored into the URL.
- A `GET /api/mcpjson` that fails asks about nothing and launches without
  answers (decided 2026-10-08). Rule 1 keeps every undecided server out of
  such a launch, so nothing runs unasked and the next launch asks again;
  refusing the launch instead would block a session over a question whose
  safe answer is already given. It is also what a newer phone gets from a
  Mac too old to have the route.

## Phone

Built for the phone too: the phone starts sessions in projects the same way
the desktop does, and a tester who starts one from the phone is owed the
same question. It reaches the phone through the two routes on the
allowlist and the shared launch path in the store. An older phone that
does not send `mcpjson` gets rule 1. The one part left out on the phone
is *View file* (§ Clients).

## Testing

- `undecidedServers`: each decision source on its own, `enableAll`, a
  missing `.mcp.json`, malformed JSON, a server decided in one source and
  not another.
- `recordDecisions`: creates the file, keeps unrelated keys, moves a name
  from one list to the other, is idempotent.
- `Runner.start` passes the undecided servers as `disabledMcpjsonServers`
  (fake SDK, as the existing runner tests do).
- `POST /api/sessions` with and without `mcpjson`; `GET /api/mcpjson`; both
  reachable through the remote allowlist.
- The launch flow in the store: no undecided servers → no question;
  undecided → question, then launch with the answers; cancel → no launch.
- Once by hand against the real CLI: the marker-file reproduction from the
  fix doc no longer writes its marker until the server is allowed, and
  `claude` in a terminal does not ask again afterwards.
