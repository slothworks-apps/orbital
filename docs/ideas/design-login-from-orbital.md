---
id: design-login-from-orbital
title: Sign in to Claude Design from Orbital
status: done
type: idea
domain: sessions
related:
  - log-in-a-claude-directory-from-orbital
  - mcp-login-from-orbital
tags:
  - accounts
  - mcp
---
# Sign in to Claude Design from Orbital

The DesignSync tools fail with "run /design-login" when the account has
no Claude Design credential. `/design-login` is a TUI command, so the
user has to open a terminal for one step, the same gap
[[mcp-login-from-orbital]] closed for MCP servers.

## What the CLI exposes

Found on the CLI bundled with SDK 0.3.287; not yet spiked end to end.

`claude design-login --json` is a hidden subcommand the VS Code
extension runs. It writes JSON lines to stdout.

- `--status` reports the state and exits, e.g.
  `{"available":true,"signed_in":false,"can_sign_in_here":true}`. That
  is enough for a "Claude Design: signed in / Sign in" row in Settings.
- Without `--status` it runs the sign-in: a browser authorization that
  times out after five minutes, with a manual fallback.

It refuses to run in two cases, and Orbital's server has to avoid both:

- stdin is a TTY ("run by the VS Code extension, not by hand");
- it was spawned from inside a Claude Code session ("cannot be signed
  in from inside a Claude Code session"), detected from the
  `CLAUDECODE` / `CLAUDE_CODE_*` environment. A child of Orbital's
  server started from a session (dev mode) inherits those; the spawn
  has to drop them. With only `HOME`, `PATH` and `USER` it ran.

The command is hidden and undocumented, so it can change with any CLI
update, like the transcript format. Read its JSON field by field and
refuse a shape it does not recognise, as `mcpLoginUrl` does.

Still to find out in a spike: the JSON events of the sign-in itself
(the URL to open, waiting, done, error), whether the manual fallback
needs a pasted code, whether the credential is per `CLAUDE_CONFIG_DIR`,
and whether a running session's DesignSync picks it up or needs an MCP
reconnect.

## Phone

Left out: the sign-in opens a browser on the Mac.
