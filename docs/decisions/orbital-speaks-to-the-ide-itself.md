---
id: orbital-speaks-to-the-ide-itself
title: Orbital connects to the IDE extension itself rather than waiting for the SDK
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-23-ide-bridge-design
  - git-location-is-ambient-not-recorded
  - feature-parity-with-the-claude-code-cli
  - subagent-liveness-from-sdk-task-events
tags:
  - ide
  - mcp
---
# Orbital connects to the IDE extension itself rather than waiting for the SDK

## The problem

A CLI session running in a terminal inside WebStorm knows things Orbital does
not: which file is open, where the caret is, which lines are selected. You
select a block, type a question about it, and the terminal carries the block
along. Orbital cannot do that, so any question about code on screen means
switching back to the terminal — which is the habit Orbital exists to break.

The Agent SDK does not carry any of it. `--ide` is an option on the
interactive command only; the SDK's spawn arguments do not include it, and the
selection plumbing in the CLI is a React hook inside the TUI. `sdk.d.ts` has no
option that attaches a session to an editor and no message type that would
deliver a selection. There is nothing to switch on.

So the question is not *whether* the SDK exposes this — it does not — but what
Orbital does about that.

## What was decided

**Orbital opens its own connection to the IDE extension, as a second MCP client
alongside whatever the CLI is doing.** Four facts are the whole protocol:

- the extension writes `~/.claude/ide/<port>.lock`, where the port is the file
  name and the JSON holds `workspaceFolders`, `pid`, `ideName`, `transport`
  and `authToken`;
- the token travels in an `X-Claude-Code-Ide-Authorization` header;
- the WebSocket must request the `mcp` subprotocol — without it the extension
  answers `400` before any of the above is read;
- what follows is an ordinary MCP `initialize`.

This was measured on 2026-09-23 against WebStorm running the Claude Code
JetBrains Plugin 0.1.14-beta, while this repository's own CLI session held a
connection to the same extension. **Both connections lived at once and both
received notifications**, which is the fact the decision rests on: Orbital does
not have to take the editor away from the terminal to use it.

The extension answered `tools/list` with `openDiff`, `close_tab`, `openFile`,
`open_files`, `get_all_opened_file_paths`, `reformat_file` and
`getDiagnostics`, and pushed `selection_changed` notifications carrying the
selected range, the selected text and an absolute path.

### What was ruled out

**Waiting for the SDK to expose it.** Nothing on the SDK surface suggests it is
coming, and the cost of waiting is paid every day in trips back to the
terminal. If the SDK ever grows the feature, this bridge is one module to
delete.

**Driving the interactive CLI with `--ide` and reading its screen.** This would
buy the integration at the price of owning a terminal UI as a subprocess and
parsing rendered output. `Runner` exists precisely so that Orbital talks to a
program with a message protocol instead of to a screen.

## What follows from it

**A second undocumented protocol, with the same standing as transcript
parsing.** Nothing here is a published interface; a plugin release can change
the tool names, the payload shape or the handshake. The bridge is therefore
written so that every failure is silence: no IDE, an unreadable lock, a refused
handshake, a tool that no longer exists — each degrades to the behaviour
Orbital has today, and none of them can fail a session.

**Tool sets are discovered, never assumed.** `get_all_opened_file_paths` is a
JetBrains tool name; a VS Code build of the extension offers a different set.
The bridge reads `tools/list` at connect time and treats every capability as
individually optional, so a feature that one editor supports and another does
not simply does not appear for the other.

**Orbital never takes the editor over.** It connects, listens and asks; it does
not install the extension, launch an editor, or hold the IDE responsible for
anything a session needs in order to run. The editor is an input Orbital reads
when it happens to be there, in the same spirit as
[[git-location-is-ambient-not-recorded]] — ambient state of the machine, not a
property of the session.

**The `ws` package becomes a server dependency.** `chokidar` already watches
`~/.claude`; the WebSocket client is new, and the extension's handshake rules
out the platform `WebSocket`, which cannot send custom headers.
