---
id: 2026-11-09-harness-from-new-session-design
title: Harness from the New session dialog — a session that starts on its checklist
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-session-harness-design
  - a-harness-continues-from-its-checklist-not-a-judge
  - a-phone-feature-waits-for-the-mac-that-serves-it
tags:
  - harness
  - new-session
---
# Harness from the New session dialog

Builds on [[2026-09-30-session-harness-design]].

## Why

A harness is attached today from the Harness panel of a session that
already exists. When the template carries the whole task (its input is a
link to a ClickUp task that describes everything), there is nothing to
write as a first prompt. The user launches an empty session only to open
its panel, pick the template and fill the link in. The template should be
pickable where the session is made, and the session should start on its
checklist.

## Behaviour

### The dialog

- Step 1 is today's dialog, unchanged. While the Harness switch is on its
  footer gains a **With harness…** button between Cancel and Launch
  session. Launch session stays the primary button and keeps ⌘⏎: most
  launches have no harness.
- **With harness…** replaces the body with step 2 in the same window, at
  the same size and place. ‹ Back and esc go back to step 1 with
  everything kept, and nothing typed in either step is lost.
- Step 2 lists the templates the Harness panel's start view would offer
  for the chosen directory: that project's templates first, then the
  global ones, never another project's. The list follows the directory
  chosen in step 1.
- The picked template shows its inputs, the Feeling lucky switch and its
  steps, with the start view's rules: an input is required unless its
  hint says optional, and Feeling lucky starts at the template's default.
- **The template of the latest harness run in this project is
  preselected**, when it is still offered. This is safe because step 2 is
  entered only on purpose: a plain Launch never starts a checklist.
  The server answers it with the list (`lastUsedId`), so the phone gets
  the same and nothing new is stored.
- The First prompt of step 1 is the same text in step 2, labelled as a
  note for step 1 and optional. In step 2, ⌘⏎ is **Launch with harness**,
  blocked while a required input is empty or no template is picked; the
  footer summary says which. Nothing is drawn in red.
- Without templates for the directory, step 2 says so and links to
  Settings → Harness templates.
- On another member of the device group whose Orbital does not serve the
  templates route yet, step 2 says that Mac has to be updated first.

### The first message

- With a template and no prompt, the session's first message is the
  harness kickoff, the same one the panel sends.
- With a template and a prompt, the prompt is **appended to the kickoff**
  as a note from the user: one message, one turn, the checklist first.
  The prompt is not sent as a turn of its own before the kickoff, so the
  agent cannot start work before it has the checklist.
- Attachments (images, files) ride with that one message as they ride
  with a first prompt today.
- The session is named from the harness, as a session the harness started
  is named today (`nameFromHarness`).

### The server

- `POST /api/sessions` accepts an optional
  `harness: { templateId, inputs, lucky }`.
- The template and its required inputs are checked **before** anything
  spawns. A missing template or input refuses the launch with the same
  messages the attach route gives; no session is written. This is why the
  dialog does not launch and then call the attach route: a failed attach
  would leave an empty session behind.
- After the spawn, the harness is stored on the new session and its
  kickoff (with the appended prompt) is the first turn. The launch's
  idempotency (`sessionId` per attempt) covers the harness too: a
  repeated launch does not attach twice.
- A launch with `worktree` resolves templates against the project, not
  the worktree path, as `projectRootOf` already does.
- A launch on another machine (`machine`) lists and validates templates
  on that machine: the templates live in its database.
- Templates for a directory without a session: a new
  `GET /api/sessions/harness-templates?cwd=…[&machine=…]` answering
  `{ project, templates, lastUsedId }`, `lastUsedId` being the template of
  the latest session harness in the same project, when that template is
  still offered. It sits in
  the `spawn` group of the allowlist, beside `POST /api/sessions` it
  serves: a phone that may launch sessions must see what it can launch
  with, and only such a phone may read the templates' bodies; the existing
  `/api/harness/templates` is in `settings`.

## Scope

- **Who it is for:** anyone who runs harness templates whose inputs carry
  the task.
- **Where it lives:** in the existing Harness feature, behind its switch
  (off by default). No new switch.
- **What someone updating notices:** with Harness off, nothing. With it
  on, one more button in the New session footer, With harness….
- **What can be set:** nothing new; templates and their defaults are set
  where they are today.

## Phone

Built for the phone too, in `NewSessionScreen`: a **With harness…**
button under Start session opens a pushed harness screen with the
template as one row (a sheet with search lists them, this project first),
a row per input, Feeling lucky and the steps. Start is disabled with its
reason in the button. With no template run in this directory before, the
sheet opens by itself on arrival. It uses the same
`POST /api/sessions` through the relay and the new templates route.
Whether Harness is on is decided by the chosen device's templates route,
not by the phone's settings read: that read needs the `settings` grant
and may come from another group member. The button is hidden only when
the setting is known to be off on the device that runs the session;
otherwise a 403 `harness_disabled` turns the harness screen into a
"Harness is off on <device>" state (not an error), and the desktop's step 2
does the same for a member with Harness off. A read left before its answer
or failed is read again when the screen reopens.

Because the phone updates first, the choice is gated in `MAC_FEATURES`
for the first desktop release that accepts `harness` on launch; against
an older Mac the phone does not show it (an older Mac would ignore the
field and launch a plain session).

## Design

Claude Design artifact `KFq2bwF8pqjf3W8BWNetG9`, file
`project/Feature - New session harness.dc.html`: 65a (in situ), 65b (the
states), 65c (parts), 65d (phone).

## Testing

- The launch route: harness validated before spawn (missing template,
  missing input → no session), kickoff as first message, prompt appended,
  idempotent repeat.
- The templates-by-directory route, including a worktree path resolving
  to its project.
