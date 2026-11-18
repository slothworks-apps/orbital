# Orbital

Orbital shows Claude Code sessions as a space map and runs sessions of its own,
so that several tasks can be followed and driven from one window.

## Following a session's work

**Harness**:
A checklist the user hands an Orbital session to work through, with gates
where the work waits for the user's approval.
_Avoid_: workflow, pipeline

**Step**:
One entry of a harness's checklist, written by the user or a template before
the work starts.
_Avoid_: item, task

**Gate**:
A step that waits for the user's (or the reviewer's) approval before the next
step starts.

**Progress list**:
The agent's own list of what it is going to do in a session and how far it has
got, kept up to date by the agent and shown to the user. A session follows
either a harness or a progress list, never both.
_Avoid_: checklist, plan, task list, todo list

**Item**:
One entry of a progress list: pending, in progress, done or dropped. A dropped
item stays on the list, struck through, with the reason it was dropped.
_Avoid_: step, task, todo

## Showing what a session made

**View**:
A small HTML page an Orbital session writes for one purpose, hands its data,
and shows live in its transcript, in the user's colours; what the user does
in it can go back to the session. Updating a view replaces it: it is one
thing, not a series of versions.
_Avoid_: widget, artifact, app, canvas, render
