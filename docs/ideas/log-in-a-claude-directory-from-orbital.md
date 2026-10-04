---
id: log-in-a-claude-directory-from-orbital
title: Log in to a Claude directory from Orbital
status: backlog
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
