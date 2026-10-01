---
id: mcp-config-is-written-by-the-cli-in-private-scopes
title: Orbital edits MCP config only through `claude mcp`, and only in the local and user scopes
status: draft
type: adr
domain: sessions
related:
  - 2026-10-01-mcp-servers-in-the-session-design
  - the-mcp-toggle-is-project-wide
  - mcp-server-templates
tags:
  - mcp
  - config
---
# MCP config is written by the CLI, in private scopes

## Context

Orbital lets the user add, edit and remove MCP servers so they never
need a terminal for it. The definitions live in files the CLI owns:
`~/.claude.json` (scopes `user` and `local`) and the project's
`.mcp.json` (scope `project`). The CLI rewrites `~/.claude.json`
constantly with its own state, and its format is undocumented.

## Decision

1. **The CLI writes, Orbital does not.** Every change runs
   `claude mcp add-json` / `claude mcp remove` with the CLI Orbital
   already resolves. One writer, the format stays the CLI's problem.
   Orbital reads `~/.claude.json` only to fill the edit form.
2. **Only `local` and `user`.** MCP setup is each person's own: URLs,
   tokens, local paths. `.mcp.json` is usually committed and shared, so
   Orbital never writes it, and its servers are shown and toggled but not
   edited. A shareable starting point belongs in a template without
   values (idea `mcp-server-templates`), not in a shared live config.

## Rejected

- **Orbital writes `~/.claude.json` itself** — two writers on a file the
  CLI rewrites all the time, in a format that can change with any update.
- **Offering `project` scope** — puts one person's values in a file the
  whole team checks out.
- **Leaving editing to the terminal** — Orbital's purpose is that the user
  does not need one.

## Consequences

Config editing needs a resolvable `claude`; when it is missing, only
viewing and toggling work. An edit is remove-then-add, so a failed add
restores the old definition.
