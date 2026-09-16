---
id: cli-session-registry
title: Claude Code live session registry
status: active
type: domain
domain: sessions
related:
  - 2026-09-15-orbital-design
tags:
  - claude-code-internals
---
# Claude Code live session registry

How `~/.claude/sessions/` behaves today, established against Claude Code
**2.1.236** by reading live files and the shipped binary. It is undocumented
and unversioned: a CLI bump may change any of it, so everything orbital reads
here is parsed defensively and falls back rather than crashing.

## The files

One `<pid>.json` per running CLI process, plus a sibling `<pid>.<hash>.key`
orbital does not read. A file is *not* removed when the process dies, so PID
liveness (`process.kill(pid, 0)`) is what makes an entry real —
`SessionRegistry.scan` drops entries whose PID is gone.

A full entry as written by 2.1.236:

```json
{
  "pid": 39093,
  "sessionId": "ee5fe5c5-39be-426e-b91c-6129597d735b",
  "cwd": "/Users/tomin/Projects/slothworks/orbital",
  "startedAt": 1789565377702,
  "procStart": "Wed Sep 16 13:29:36 2026",
  "version": "2.1.236",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle"],
  "kind": "interactive",
  "entrypoint": "cli",
  "messagingSocketPath": "/tmp/cc-socks/39093.sock",
  "name": "orbital-58",
  "nameSource": "derived",
  "nameSince": 1789565377702,
  "status": "busy",
  "updatedAt": 1789565410990,
  "statusUpdatedAt": 1789565410990,
  "bridgeSessionId": "session_01XUZeZ61NBSD4BsDuV8XiXw"
}
```

Orbital consumes `pid`, `sessionId`, `cwd`, `name`, `status`, `kind`,
`startedAt` and `updatedAt`. The rest is recorded here so nobody has to
re-derive it from the binary.

## The status vocabulary is the CLI's, not ours

This is the part that has already caused one bug. The CLI's own vocabulary is
four words, and **`working` is not among them**:

```
["busy", "shell", "idle", "waiting"]
```

| `status` | means | orbital status |
|---|---|---|
| `busy` | agent is mid-turn | `working` |
| `shell` | a `!` shell command is running | `working` |
| `waiting` | parked on a permission request or a question | `needs_input` |
| `idle` | genuinely doing nothing | `idle` |

`waiting` entries may also carry `waitingFor` (a string naming what is being
waited on). Orbital does not surface it yet.

The translation lives in exactly one place, `CLI_STATUS` in
`server/src/watcher/registry.ts`. An unrecognised word maps to `idle`: a
newer CLI inventing a fifth state must not be shown as live-but-unknown, and
the mapping table is where to add it.

### How this was wrong before 2026-09-16

The design spec described the field as `idle`/`working` and concluded that
needs-input "cannot be reliably detected" for terminal sessions. Both were
false. The implementation faithfully followed the spec with
`raw.status === 'working' ? 'working' : 'idle'`, so every running terminal
session — `busy`, `shell` *and* `waiting` alike — rendered as `IDLE` on the
map, and `registry.test.ts` asserted the same wrong assumption by feeding the
fixture a `'working'` that the CLI never writes.

The lesson worth keeping: fixtures for an external format must use bytes
observed from that format. A hand-written fixture agreeing with a hand-written
parser proves only that they agree with each other.

## Statuses orbital adds on top

`ended` is orbital's, never the CLI's — it means no live process, i.e. no
registry entry (`statusOf` in `server/src/api/shape.ts` falls through to it).
Web sessions bypass this file entirely; `Runner` tracks their status directly
and `statusOf` prefers the runner over the registry.

## Watching

`chokidar` on the directory, 200 ms debounce, then a full re-`scan()`. `scan`
diffs against the previous map and emits `upsert`/`remove`, so a status flip
reaches the `sessions` WS topic within roughly a debounce window.
