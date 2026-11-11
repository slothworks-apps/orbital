---
id: 2026-11-09-progress-list-design
title: Progress list — the agent's own list of what it will do and how far it has got
type: spec
status: done
domain: sessions
related:
  - progress-list-has-its-own-tool-not-the-clis-tasks
  - 2026-10-02-harness-redesign-design
  - feature-parity-with-the-claude-code-cli
tags:
  - progress-list
  - labs
---
# Progress list

A harness is a checklist the user writes before the work starts. Most work
does not start with one: the user describes a task and the agent works out
the steps itself. While it does, the user cannot see how far it has got or
what is left without reading the transcript. The CLI's own task tools
(`TaskCreate`, `TaskUpdate`) keep such a list, but it serves the agent's
own bookkeeping. Agents create it rarely, and Orbital shows it only as raw
JSON.

A **progress list** is the agent's own list of what it is going to do in a
session and how far it has got, kept up to date by the agent and shown to
the user. The terms are in `GLOSSARY.md`.

## Scope

- **Who it is for:** anyone who hands an Orbital session a task of several
  steps without writing a harness for it, and wants to see at a glance
  how far it is.
- **Where it lives:** Labs. Its reception is not known yet.
- **What someone already using Orbital notices after updating:** nothing,
  until they turn the Labs feature on. After that, the New session dialog
  has a progress list switch.
- **What can be set:** the Labs switch, and the per-session switch in the
  New session dialog, which remembers the last choice per directory.

The design is "Feature - Progress list" in the Claude Design artifact,
artboards 67a–67h.

## Behaviour

### Turning it on

- The New session dialog has a progress list switch (67f), shown only
  while the Labs feature is on on the device the session runs on (another
  member's own setting, from its session defaults). It remembers the last
  choice made in the dialog per directory, as the model does; a session
  started any other way (`spawn_session`, Clear, the control API) does not
  change it. It is the only way to turn the list on: a running
  session cannot be given one later.
- Only Orbital sessions get it. A terminal session cannot be given an MCP
  tool, so it has no progress list (by design, as with the harness).
- Only the main session gets the tool. A subagent's work belongs to the
  main session's list.
- A session follows either a harness or a progress list, never both.
  "Launch session" starts with a list when the switch is on. "With
  harness…" starts on a harness, with no list. The switch is neither
  disabled nor reset, and the launch summary says "no progress list"
  (67f). A launch from that step sends no `progressList`, so the choice
  remembered for the directory stays as it was, and the server refuses a
  launch that carries both.
- Attaching a harness to a session with a progress list **freezes** the
  list, for good: the freeze is recorded with its time, and removing the
  harness, or turning the harness off in Labs, does not undo it. It is not
  deleted: it stays readable in the transcript and opens
  in the side slot from its row, marked read only. The harness takes its
  place, and the strip's harness button says so in its tooltip (67h).
- Turning it on adds one sentence to the session's system prompt: for work
  of more than a few steps, write a progress list first and keep it up to
  date.
- While it is on, the CLI's `TaskCreate` and `TaskUpdate` tools are
  disallowed in the session, so the agent has one list, the one the user
  sees.

### Writing the list

- The agent writes the whole list at once, from what it knows when it
  starts. Every call sends the whole list with each item's state. Orbital
  keeps no item ids of its own across calls beyond what the call carries.
- An **item** is pending, in progress, done or dropped.
- The agent may add or drop items as the work goes on, at the user's
  request or because of what it finds. It must not change the list without
  the user knowing:
  - A call that adds or drops an item must carry a one-sentence reason.
    The tool refuses the call without one.
  - So must a new list (`new_list`) that replaces one, saying why the
    previous list ends; the session's first list needs none.
  - Each such change shows a row in the transcript: what was added, what
    was dropped, and the reason.
  - A dropped item stays on the list, struck through, with its reason. It
    does not count towards the progress figure.
- A state change alone (pending → in progress → done) needs no reason and
  shows no transcript row.
- For a new task in the same session the agent starts a new list. The
  previous one stays in the transcript. The progress readouts follow the
  new one.

### Showing it

- **Next to the session panel (67b):** a pill built like the harness's,
  in the same place, with one segment per counted item and the list glyph
  on top. Hovering gives a flyout; pressing it, or ⌘⇧P, opens the list in
  the harness's side slot (67c).
- **The list (67c):** items in order, the four states in the harness's
  colours without amber. The header carries the figure (done of
  not-dropped, say 3/7) and what it leaves out ("1 dropped · 4 to go").
  Nothing in it looks pressable except ×. There is no percentage
  anywhere.
- **On the map (67e):** the figure is label text after the session's name,
  muted, never a mark on the planet; the label always makes room for a
  two-digit figure, so a tick never moves the neighbours. At far zoom the name is cut before
  the figure; at the farthest the figure stays alone under the planet. It
  hides with its label; ended planets and frozen lists show none. On Desk
  it ends the card's meta row, over its end, the meta text fading out
  under it.
- **In the transcript (67d):** the harness's dashed row with the list
  glyph, for a list written, items added or dropped, a new list, and a
  freeze. The tool calls themselves render as those rows, not as JSON.
- The user cannot edit the list. To change it, they tell the agent, who
  writes the change with its reason.
- It is a view of the work, nothing more. When a turn ends with items
  left, Orbital does nothing: no nudge, no notification, no change of
  state. Continuing on its own is the harness's job.

The look and the exact placement of the pill, the panel and the map figure
come from Claude Design.

### Where the state comes from

The list is rebuilt from the tool's calls in the session's transcript; it
has no table of its own. Every call carries the whole list, so the last
call is the current state, and the calls before it give the change rows.
A resumed or restarted session therefore shows the same list without
extra persistence.

The store holds only the newest page of a transcript, so the web and the
phone read the calls from before it through
`GET /api/sessions/:id/progress-calls`: the live branch's tool calls and
their results, oldest first, in the messages route's shape and ids, filtered
from the same cached read. One small answer instead of paging the whole
transcript back, which on the phone would cross the relay.

### How the Mac keeps it

- The tool is `progress_write` on Orbital's `orbital` MCP server, written
  `mcp__orbital__progress_write` in transcripts (`PROGRESS_TOOL` in
  `shared/src/progress.ts`). The fold of its calls — the list, and what each
  call changed — lives in that module, for the server, the web and the
  phone alike.
- The launch's `progressList` flag is kept on the session's row
  (`sessions.progress_list`), so a revive, an MCP restart and a resume give
  the session the tool again. Clear carries it to the new session, unless
  the harness goes on there.
- Subagents share the session's MCP server, so they see the tool; a
  `PreToolUse` hook refuses their calls.
- Only calls on the transcript's live branch with a result that is not an
  error count: a refused call does not, and a rewind takes its calls back.
  The branch is the one the messages route presents: a pending rewind, or
  a sent one whose new branch has not landed, cuts it before its target.
- The server reads a session's list from its transcript once, again at
  each start, when a rewind is picked, cancelled, refused or sent, and once
  more when a sent rewind's new branch lands; between, the calls the tool
  accepts keep it current. The web reads the calls before its newest page
  once per load of the transcript (picked again, a reconnect, a rewind's
  reset), and again after a failed read.
- The Labs switch, `progress_list_enabled`, gates the launch flag (403
  `progress_list_disabled`), the tool and the session's figure. A session
  started with a list while it was on keeps its row, but gets no tool and
  carries no figure while it is off, on the desktop and the phone alike.
- The freeze is `sessions.progress_frozen_at`, set when a harness is first
  attached to a session with a list; `ApiSession.progress.frozenAt` carries
  it, and the frozen row and panel show its time.

## Phone

Built for the phone too (67g):

- A progress readout in row 2 of the session header, where the harness
  shows `HarnessProgress`.
- A sheet with the full list, like the harness's `StepsSheet`.
- The figure in the session list, under the time, in muted mono, only on
  sessions that have a list, and not once it is frozen.

The list reaches the phone with the session (the same session shape the
harness step uses) and the `progress-calls` route, which is on
`server/src/remote/allowlist.ts`; the phone gates the readout in
`MAC_FEATURES`, because the phone updates before the Mac.

## Not in this feature

- Showing the CLI's own `TaskCreate`/`TaskUpdate` calls readably in
  terminal sessions. That is the parity gap in
  `docs/audits/feature-parity-with-the-claude-code-cli.md`, separate from
  this.
- Editing the list from the UI.
- Progress on the sidebar row.
- Turning a list on in a running session.
- The far-zoom behaviour of 67e (name cut first, the figure alone at the
  farthest zoom, collisions): the map's labels do not change with zoom
  today, so the figure follows the shortened name at every zoom. Doing 67e
  in full changes every planet's label and needs its own decision.
- Starting a session with a progress list from the phone; 67g has no
  switch for it.
