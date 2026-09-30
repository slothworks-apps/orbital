---
id: 2026-09-30-a-session-spawns-sessions-design
title: A session spawns sessions — new planets from inside a running session
status: done
type: spec
domain: sessions
related:
  - mcp-servers-in-the-session
tags:
  - server
  - runner
---
# A session spawns sessions

## Problem

A session can split its work into subagents, but those stay moons of the
same planet: they share its turn, its context and its end. When the work
is really several independent tasks — another repository, a follow-up
that should outlive this conversation — the user has to open the
new-session dialog by hand and retype the task. The session already
knows what it would write there.

## Rule

A session run by Orbital can start another Orbital session. The new
session is an ordinary planet: the same one the new-session dialog
would have made. Nothing ties it to the session that started it, beyond
one unseen mark (§ Chains).

Terminal sessions do not get this. They are not run by Orbital, so there
is no process to hand the tool to (the Orbital-first rule).

## The tool

The Runner gives every session it starts one in-process MCP server
(`createSdkMcpServer`, passed as `options.mcpServers`). It sits beside
the servers the CLI loads from settings; `strictMcpConfig` stays off, so
the user's own servers are unaffected.

The server has one tool, `spawn_session`:

| input | required | meaning |
|---|---|---|
| `prompt` | yes | the new session's first message |
| `cwd` | no | working directory; defaults to the parent's cwd; `~` is expanded |
| `model` | no | any model id the new-session dialog accepts; defaults to the parent's current model |

The permission mode is not an input. The new session takes the mode the
parent is in at the moment of the call, so a model cannot hand itself a
wider mode than the user gave it.

It does not accept attachments, a tag or a session id. The auto-tagger
and the titler treat the new session the way they treat one started from
the dialog.

The tool's description tells the model this is not how it delegates.
Splitting its own work is what subagents are for; `spawn_session` is
for when the user asks for a separate session in so many words ("start
a new session for…", "open another planet that…"). Without a request
like that the model does not call it.

The tool returns as soon as the new session has started: its id, its
cwd and one line saying it now runs on its own. The parent does not wait
for the child and never receives its output — that is what subagents
are for.

Refusals come back as a tool error the model can read and relay:

- `cwd` is relative, does not exist or is not a directory;
- the user declined the permission prompt;
- the parent session is no longer active.

## Asking

The first spawn goes through the same permission path as any other tool
call: in `default` and `acceptEdits` the user sees the usual permission
prompt with the prompt and cwd; in `bypassPermissions` it runs without
one. That is the mode doing what it says.

## Chains

A session started by `spawn_session` carries a mark: `spawned_by`, the
id of the session that started it (a new nullable column on
`sessions`). The mark is not drawn anywhere; the map, the lists and the
detail panel ignore it.

For now the mark limits nothing. A spawned session has the tool on the
same terms as any other, so a chain can grow — under
`bypassPermissions` without a prompt. The tool description is the only
brake. The mark is recorded so that a limit can be added later without
guessing which sessions were spawned. The limit considered: every spawn
by a marked session asks the user in every mode, parked by the tool
handler itself on the Runner's decision machinery, since under bypass
the CLI never calls `canUseTool`.

## What does not change

- Sessions started from the dialog, and terminal sessions, never carry
  the mark.
- Ending, pinning, rewinding and clearing treat a spawned session like
  any other; ending the parent does not touch the child.
- `POST /api/sessions` keeps its contract. The tool and the route call
  one shared function that starts the run, writes the row and publishes
  the `upsert`; only the tool passes `spawned_by`.

## Tests

- The tool starts a session with the parent's mode and model, and the
  row carries `spawned_by`.
- A missing `cwd` is refused without starting anything.
- A `model` passed to the tool wins over the parent's.
