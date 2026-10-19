---
id: orbital-features
title: Every feature of Orbital, and how a session reaches it
type: domain
status: in-force
domain: control
related:
  - 2026-10-13-orbital-controls-itself-design
  - an-orbital-session-drives-orbital-through-a-catalog
tags:
  - server
  - mcp
---
# Every feature of Orbital, and how a session reaches it

The map of what Orbital does, by area, and the way a session Orbital runs can
drive each feature through its `orbital` MCP server. Operations are the names
in `server/src/control/catalog.ts`, called through `orbital_read` (reads, no
permission card) and `orbital_act` (changes, the usual card). The dedicated
tools — `spawn_session`, `list_sessions`, `archive_session`, the harness's
`harness_*` — are listed where they belong. A session in a device group can
pass `machine` (another group member's id) to most operations to run them on
that member; `list_devices` names the group's other members.

## Devices

A session in a device group can run operations on other members. `list_devices`
names them; pass one's id as `machine` to `orbital_read`, `orbital_act` or
`spawn_session`.

## Sessions

| feature | how a session reaches it |
|---|---|
| list other devices in a group | `list_devices` |
| list, count, search and filter sessions | `list_sessions` tool; `list_sessions`, `count_sessions` |
| one session with its history | `get_session` |
| start a session (new planet), resume one | `spawn_session` tool; `start_session`; pass `machine` to start it on another group member |
| New Session defaults, recent projects, missing folder | `session_defaults`, `list_projects`, `check_directory`, `create_directory` |
| rename, retitle with the titler | `rename_session`, `retitle_session` |
| pin | `pin_session` |
| End (archive), Undo | `archive_session` tool; `end_session`, `reopen_session` |
| Clear (end and start fresh, carrying the harness) | `clear_session` |
| switch model, switch permission mode | `set_model`, `set_permission_mode` |
| stop a turn | `interrupt_session` |
| retention sweep preview | `retention_preview`; the sweep itself through `update_settings` |

## Conversation

| feature | how |
|---|---|
| read the transcript | `list_messages` |
| send a message, wake an ended session | `send_message` |
| rewind, cancel a rewind | `rewind_session`, `cancel_rewind` |
| media gallery | `list_media` |
| subagent transcripts | `subagent_messages` |
| background tasks: output, stop | `task_output`, `stop_task` |
| attachments (images, files) | not reachable: bytes |

## Decisions

Permission cards, plan approval and questions: `answer_decision`, with the
decision id from `get_session`.

## Harness

Templates (list, create, edit, duplicate, delete, draft, interview), a
session's harness (attach, pause, options, remove, carry), gates (approve,
reopen, go back, decide myself) and a step's diff — one operation each,
area `harness`. A session's own checklist keeps its `harness_*` tools.

## Tags and tag rules

Tags (create, rename, recolour, move their cluster, delete), a session's
tags, and the rules that tag automatically (add, reorder, enable, delete,
preview) — areas `tags` and `tag_rules`.

## Settings

Every setting through `get_settings` and `update_settings`: map theme and
what the map shows, planet scale, context thresholds, transcript diffs, the
permission gesture, header strip, notifications, session instructions,
usage-limit auto-continue, updates, retention, and the experimental switches
(harness, walkthrough, terminal, archipelago). Not writable by a session: the
phone relay (`remote_*`) and the CLI path.

## MCP servers

A running session's servers: list, add, edit, remove, reconnect, toggle,
log in, restart; a project's undecided `.mcp.json` servers and the file one
runs — area `mcp`.

## Accounts, models, commands

Claude directories (list, add, rename, move, remove), models (list, validate
a custom id), slash commands and skills (list, read) — areas `claude_dirs`,
`models`, `commands`.

## Files, editor, git

File preview and @-completion, the connected editor (open tabs, open a file,
diagnostics), the PR and line-change indicator (`gh_status`,
`refresh_branch_status`).

## Stats, limits, errors, walkthrough

Usage and cost overview, a session's drilldown, plan limits and refresh, a
session's wait for the limit reset (cancel, undo), the error log (read, mark
seen), the walkthrough (read, summary, narrate).

## Not reachable from a session

| feature | why |
|---|---|
| the map itself: camera, zoom, selection, which panel is open, the sidebar, keyboard shortcuts, the sound | state of the browser window, with no route on the server |
| the terminal inside Orbital | an interactive shell over a WebSocket; a session has its own Bash |
| pairing a phone, revoking one, the relay | the user's alone: it hands out access to the Mac |
| images and uploads | bytes, not JSON |
| the desktop app: window, native notifications, updates | lives in Electron, not the server |
| sessions started in a terminal | they run the CLI's own MCP config, not Orbital's server |
