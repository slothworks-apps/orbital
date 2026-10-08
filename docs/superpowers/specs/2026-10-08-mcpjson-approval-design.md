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
4. **Revives and the other paths never ask.** A server added to
   `.mcp.json` after a session started stays out of it until the user
   decides, which happens on the next new session in that project. A
   question in the middle of sending a message would interrupt the one
   thing the user is doing; keeping the server out is the safe answer, and
   the MCP dialog of that session simply does not list it.

## Server

- `server/src/mcp/mcpjson.ts`: `undecidedServers(cwd, claudeDir)` reads
  `.mcp.json` and the four decision sources above, and returns
  `{ name, command, args }[]` (the command and args as written, for the
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
- Both routes go on the phone allowlist (`server/src/remote/allowlist.ts`).
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
- What the question looks like, and where it sits, comes from Claude
  Design. The brief: a question inside the new-session flow, not a
  separate alarm; per server its name and the full command it would run,
  in mono; two choices per server; one confirm for all; calm in the sense
  of `docs/why-orbital.md` — no red, no warning icon, the wording says what
  will run and lets the user decide. Desktop and phone variants.

## Phone

Built for the phone too: the phone starts sessions in projects the same way
the desktop does, and a tester who starts one from the phone is owed the
same question. It reaches the phone through the two routes on the
allowlist and the shared launch path in the store. An older phone that
does not send `mcpjson` gets rule 1.

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
