---
id: log-in-a-claude-directory-from-orbital
title: Log in to a Claude directory from Orbital
status: done
type: idea
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - mcp-login-from-orbital
tags:
  - accounts
---
# Log in to a Claude directory from Orbital

A Claude directory added in Settings may never have been logged in to,
for example a fresh `~/.claude-work` for an enterprise account. Today
that takes one `CLAUDE_CONFIG_DIR=<dir> claude` and `/login` in a
terminal, and the first session Orbital starts under the directory fails
until someone does it.

Orbital should offer the login itself: a "Log in" action on the
directory's Settings row that runs the CLI's login flow under that
directory and opens the browser for the OAuth step. A directory with no
login could also say so in the row, if the CLI gives a cheap way to ask.

First find out what the SDK or CLI exposes for this. A non-interactive
`claude auth`-style command, or an SDK control request like the MCP
`mcpAuthenticate` family, would do. Then decide.

## What the CLI exposes

Found on the CLI bundled with SDK 0.3.287; not yet spiked end to end.

- `claude auth status --json` answers `loggedIn`, `authMethod`,
  `apiProvider`, `email`, `orgId`, `orgName` and `configDirectory`. Run
  under `CLAUDE_CONFIG_DIR=<dir>`, it is the cheap way to ask whether a
  directory is logged in, for its Settings row.
- `claude auth login` (`--claudeai` by default, `--console`, `--sso`,
  `--email <address>`) opens the browser and catches the OAuth callback
  on `localhost` itself, as `mcpAuthenticate` does. When the callback
  does not arrive it falls back to `Paste code here if prompted >` on
  stdin, so Orbital needs a field to paste the code into, or has to
  refuse that path.
- `claude auth logout` exists too.

Still to find out in a spike: what `auth login` prints on stdout before
and after the browser step when stdin is not a TTY, and whether a
running session under the directory picks up the new login or has to be
restarted.

## Phone

Left out: the login opens a browser on the Mac. The phone could show the
directory's logged-in state, nothing more.

See also [[design-login-from-orbital]] for the Claude Design sign-in,
which works the same way.
