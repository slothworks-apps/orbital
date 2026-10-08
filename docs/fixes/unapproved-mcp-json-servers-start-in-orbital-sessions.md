---
id: unapproved-mcp-json-servers-start-in-orbital-sessions
title: An Orbital session starts a project's .mcp.json servers without the CLI's approval
status: done
type: fix
domain: sessions
related:
  - 2026-10-01-mcp-servers-in-the-session-design
  - mcp-config-is-written-by-the-cli-in-private-scopes
  - 2026-10-08-mcpjson-approval-design
tags:
  - mcp
  - security
---
# Unapproved .mcp.json servers start in Orbital sessions

## What happens

A terminal session asks before it connects a server from a project's
`.mcp.json` (the approval lands in `enabledMcpjsonServers` in
`~/.claude.json`). An Orbital session does not: under the SDK, with
`settingSources: ['user', 'project', 'local']`, such a server connects
straight away.

Seen on 2026-10-01 with SDK 0.3.278 and an isolated `CLAUDE_CONFIG_DIR`:
the project entry had `hasTrustDialogAccepted: false` and
`enabledMcpjsonServers: []`, and the `.mcp.json` server still reported
`connected`, `source: 'project'`.

## Why it matters

Opening an Orbital session in a freshly cloned repository runs whatever
command that repository's `.mcp.json` names, with no prompt.

## Possible fix

Before starting a session, compare the project's `.mcp.json` servers
with `enabledMcpjsonServers` / `disabledMcpjsonServers` /
`enableAllProjectMcpServers`; for any server not yet decided, ask in the
UI, and record the answer through the CLI rather than by writing
`~/.claude.json`. Check first whether a CLI option makes the SDK honour
the approval itself.

## Still reproduces, 2026-10-07

Re-checked with SDK 0.3.287: a temporary project whose `.mcp.json` names a
server that only writes a marker file, an isolated `CLAUDE_CONFIG_DIR` with
`hasTrustDialogAccepted: false` and empty `enabledMcpjsonServers`, and
`query()` with Orbital's `settingSources`. `system/init` listed the server as
`pending`, `source: 'project'`, and the marker file was written, so the
command ran without approval. `sdk.d.ts` has no option that makes the SDK
honour the approval; the settings keys are only typed as settings. The fix
has to be Orbital's own check before the session starts.

## 2026-10-08: the server keeps undecided servers out

Correcting the note above: the SDK does honour a decision passed to it.
`query()` with `settings: { disabledMcpjsonServers: [...] }` keeps those
servers from starting, in memory, with nothing written (spike with SDK
0.3.287). `Runner.start`, which every start path goes through, now passes
every server of the project's `.mcp.json` that no settings source has
decided, so none of them runs until the user approves it
([[2026-10-08-mcpjson-approval-design]]). The server side of recording an
answer is in place too. Still pending: the question itself in the desktop
and phone New Session flow, whose look comes from Claude Design.
