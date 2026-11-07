---
id: orbital-sessions-get-the-artifact-tool
title: Orbital sessions get the Artifact tool
status: in-force
type: adr
domain: sessions
tags:
  - server
---
# Orbital sessions get the Artifact tool

## The problem

Claude Design projects are moving into claude.ai artifacts. A link such as
`https://claude.ai/artifact/<id>` is private to the account that made it, and
a session implementing a design has to read it. The CLI ships an Artifact tool
that does, but only when `CLAUDE_CODE_ARTIFACT=1` is in its environment, and
a session Orbital spawns through the Agent SDK does not get it otherwise. The
Claude Docs connector's `read` refuses such a link.

Checked 2026-11-07 with SDK 0.3.287: without the variable the `init` message
lists no Artifact tool; with it, both the CLI bundled in the SDK (2.1.287) and
a Homebrew `claude` (2.1.280) list the tool and read a private artifact of the
signed-in account.

## What was considered

- **Make the artifact public and fetch it.** Publishes private design work.
  Ruled out.
- **Have the session shell out to `CLAUDE_CODE_ARTIFACT=1 claude -p …` and
  save the files.** Works, but every implementation session has to know the
  incantation, and it pays for a second CLI run.
- **A switch in Settings or Labs.** Adds a surface for a tool the CLI already
  ships; there is nothing a person would set differently.
- **Set the variable for every session Orbital runs.** Chosen.

## Decision

The runner adds `CLAUDE_CODE_ARTIFACT=1` to the `env` it passes to `query()`.
The tool reads and writes artifacts of the account the CLI is signed in to,
nothing beyond it; the permission mode of the session governs its calls like
any other tool's.

## Scope

- **For** anyone whose designs or documents live in claude.ai artifacts.
- **Where** on by default, in sessions Orbital spawns. Terminal sessions are
  only shown, so they keep whatever the person's own shell sets.
- **Noticed after updating** a session can open an artifact link it is given;
  nothing else changes on screen.
- **Settings** none.

## Phone

Reaches the phone without any change there: a session started or continued
from the phone runs on the Mac, through the same runner.
