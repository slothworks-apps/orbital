---
id: built-in-commands-are-remembered-across-restarts
title: Built-in commands are remembered across restarts
status: in-force
type: adr
domain: server
related:
  - 2026-09-20-composer-design
tags:
  - composer
---
# Built-in commands are remembered across restarts

Only the CLI knows its built-in commands (`/compact`, `/clear`, `/model`…),
and `GET /api/commands` could ask for them only while the session had a live
SDK query. Without one, which is every session right after Orbital restarts,
the route answered with the filesystem scan alone, so the built-ins were left
out on purpose: offering a command the CLI may not honour seemed worse than
omitting it.

In practice this meant the same session recognised `/compact` before a
restart and not after it. The composer left the slug untinted and called it
an unknown command, even though sending it would have worked: a send to a
session with no live query starts one, and the CLI handles the slash command
in that prompt.

## Decision

Every live answer stores its built-ins (the entries the scan did not
attribute, minus Orbital's own `/rewind` and `/mcp`) in the `settings` row
`cli_built_in_commands`. When no query is live, the route returns the scan
plus these remembered built-ins. This applies to a session and to the New
Session dialog's `?cwd=` alike, since that dialog's first prompt also starts
a query.

The built-ins belong to the CLI as a whole, not to one session, so a single
row is enough. Whichever session was live most recently wins.

## Rejected

- **Ask the CLI in the background.** Spawn a CLI process just to call
  `supportedCommands()` whenever nothing is live. The list would always be
  exact, but every catalog fetch on an idle session would cost a process
  start and a delay before the slug is tinted.

## Consequences

- If the CLI is updated between restarts and drops a command, the
  remembered list can still offer it until a session goes live again. Then
  the CLI rejects the command instead of the composer warning about it.
- Before the very first live session on a fresh install, nothing is
  remembered yet, and the earlier behaviour holds.
- A command an MCP server or a plugin added in one session can be offered
  in another after a restart. The CLI decides at send time whether it is
  real.
