---
id: subagents-only-for-orbital-sessions
title: Moons only orbit orbital's own sessions
type: adr
status: in-force
domain: subagents
related:
  - subagents-in-transcripts
  - 2026-09-16-subagents-everywhere-design
---

# Moons only orbit orbital's own sessions

## Context

Orbital drew moons for the subagents of any session. Making that work for
terminal sessions meant watching their transcripts, which was built: a
`LiveSubagentWatcher` following every live session, a catch-up read of each
transcript, and a `watch_live_subagents` setting to switch the cost off.

Then measurement (see [[subagents-in-transcripts]]) showed the premise was
false. Claude Code writes a subagent's `Agent` call and its result to the
transcript **together, when the subagent has already finished** — every
completed call has ~70ms between the two, for work that took minutes. With a
subagent visibly running for nine minutes, no transcript on the machine held
an unresolved call.

So transcript watching, however thorough, can only ever report "none running"
for a terminal session.

## Options

1. **Keep the watcher anyway.** It costs almost nothing and would start
   working if Claude Code ever wrote the call earlier.
2. **Read the live channel.** A terminal session's `/tmp/cc-socks/<pid>.sock`
   is the only place its running subagents exist outside the process.
3. **Drop it.** Subagents only for sessions orbital runs itself.

## Decision

**Option 3.** Tomin's reason decides it: orbital is meant to become where he
runs sessions from, so the sessions that matter are the ones orbital starts,
and those already have live subagent state from the SDK stream at no cost.

Option 1 keeps a watcher, a setting, a settings row and a multi-megabyte
parse per session opened, all to answer a question whose answer is always
"none". Dead weight that reads as a working feature.

Option 2 means reverse-engineering an undocumented protocol that the original
design (`2026-09-15-orbital-design`) already listed as a non-goal, to serve
the sessions we are moving away from.

## Consequences

- `ApiSession.subagents` is always empty for terminal sessions. The map draws
  no moons for them — correct, not a bug.
- Subagent detection has one feeder, `Runner.onEntries`, and no setting.
- Reversing this is cheap: the watcher and its tests are in git history, and
  the store it fed is unchanged.
- **If orbital ever needs live state from a terminal session** — subagents or
  anything else — the socket is the only route, and that is a project of its
  own, not a patch to this one.
