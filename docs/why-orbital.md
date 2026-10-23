---
id: why-orbital
title: Why Orbital exists, and the calm it keeps
type: reference
status: in-force
related:
  - a-session-ends-only-when-the-user-ends-it
  - subagents-only-for-orbital-sessions
tags:
  - principles
---
# Why Orbital exists, and the calm it keeps

This is what Orbital is for and the rules it holds itself to. Weigh every
new feature against it. Where a feature and this document disagree, the
document wins, unless an ADR says why this case is different.

## What it is for

When several Claude Code sessions run at once, keeping track of them costs
attention: which one is still working, which one is waiting for you, which
one has finished. Orbital puts all of them on one map so that this costs as
little as possible.

Orbital is meant to replace the Claude Code CLI, not to sit next to it.
Everything you would do in a terminal session, you can do in a session
Orbital starts.

## For developers

- **Nothing the CLI can do is missing.** A gap between the two is a bug to
  close, not a trade-off to accept.
- **You can always see what the agent did.** The tools it called, the
  changes it made and the subagents it started are there to read, not
  summarised away.
- **Nothing locks you in.** Orbital's sessions are ordinary Claude Code
  sessions, written to the same transcripts the CLI writes. Orbital adds no
  format of its own that you would have to leave behind.

## Terminal sessions are shown, not driven

Orbital reads the sessions you run in a terminal and shows them read-only.
It does not try to drive them, mirror every CLI feature onto them or keep
up with the terminal's own behaviour. Features may exist only for sessions
Orbital starts, and that is deliberate: full terminal compatibility would
load Orbital with work that serves the sessions it is meant to replace.

The one thing Orbital does to a terminal session is take it over, when you
ask: it quits the CLI in the terminal and the conversation goes on in
Orbital, as one of its own sessions. That moves you off the terminal
rather than driving it.

## What gets in

Orbital stays small enough for one person to hold in their head. Every
feature is weighed against that before it is built.

- **Useful to developers in general.** A feature earns its place when most
  people who run several Claude Code sessions would use it. One person's
  workflow, however well built, does not get in. Closing a gap with the CLI
  always qualifies (see "Nothing the CLI can do is missing").
- **Inside what Orbital is for.** Following several sessions at once, or
  replacing the CLI. Something outside both needs an ADR that says why.
- **An update changes nothing you did not choose.** A new feature arrives
  off, in Labs, or as an option beside the old behaviour. It replaces what
  users already rely on only when it is plainly better for everyone.
- **Configurable where people genuinely differ.** Where a choice of form or
  place is a matter of taste — statistics as a panel or as a button in the
  session header — it is a setting. A setting for every detail is not.
- **Every new surface costs attention.** A new tab, panel, header element or
  map marker is the most expensive way to add something. Extend what exists
  first.

### Experimental, Labs, and out

- **Experimental** (hidden in Settings) holds work in progress, for the
  maintainer and testers.
- **Labs** (visible in Settings, every switch off) holds finished features
  whose reception is not known yet. Turning one on shows its settings with
  the rest, or as its own tab when it is large enough.
- From Labs a feature is either promoted, to the regular settings or on by
  default, or removed. It does not stay in Labs for good.

## Calm

A tool that watches several streams of work at once can add pressure or take
it away. Orbital takes it away. Interruptions break concentration, and a
steady sense that something has to be answered right now wears people out.
Orbital is built so that it never produces either.

### Nothing blinks

Motion on the map shows state, slowly. It never exists to pull your eye.

- **Allowed:** slow orbits, gentle transitions between states.
- **Ruled out:** blinking, fast or jerky pulsing, a bouncing Dock icon,
  anything that flashes to make you look.

### Waiting is fine

A session waiting for your answer is a calm state, not an alarm. The agent
will wait.

- **Allowed:** a clear, quiet marker that a session is waiting, and for what.
- **Ruled out:** alarm colours for waiting, countdowns, timers that tell you
  how long you have kept it waiting, reminders that repeat or grow louder.

### Silence by default

Orbital makes no sound and keeps no unread counts unless you ask for them.

- **Allowed:** notifications you turned on yourself, quiet, and respecting
  the system's Focus mode.
- **Ruled out:** sound that is on before you chose it, badges and counters
  that pile up, notifications for events you did not ask about.

### You look when you choose to

Orbital does not call you. It waits until you look, and what you find is
complete.

- **Allowed:** keeping everything in place until you come back to it.
- **Ruled out:** anything that disappears or ends behind your back. A
  session ends only when you end it.

## Doing several things at once

Orbital makes it cheaper to follow several pieces of work, and it shows
honestly how many are running and how many are waiting for you. It does not
judge that number and does not limit it. How much to take on is your
decision; Orbital's part is that you make it seeing the real state.
