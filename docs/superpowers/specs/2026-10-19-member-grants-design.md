---
id: 2026-10-19-member-grants-design
title: What another member may do on this device is granted per member, in groups of routes
type: spec
status: done
domain: remote
related:
  - 2026-10-16-device-group-design
  - every-member-reaches-one-literal-allowlist
  - 2026-10-13-orbital-controls-itself-design
tags:
  - remote
  - security
  - mcp
---

# Member grants

## Problem

Every member of a group reaches one literal allowlist
([[every-member-reaches-one-literal-allowlist]]). The orbital MCP of a
session on one Mac can therefore not drive another Mac as fully as its
own: the catalog's operations on Claude directories, errors, branch
status, model validation and the IDE are not on the list, and the MCP
has no way to name another device at all. Nor can the user take back
from one member what every member may do.

## 1. Grants

What a member may call on this device is the union of the **grant
groups** this device gave it. Every route on the allowlist belongs to
exactly one group; the list stays literal, a route on no group reaches
no member.

| group | default | what |
|---|---|---|
| `sessions` | on | read and drive sessions: messages, decisions, interrupt, model, permission mode, harness, walkthrough, a session's MCP servers, files, commands, stats, limits |
| `spawn` | on | start sessions: `POST /api/sessions`, the directory check and its create, the folder chooser, projects, `.mcp.json` |
| `settings` | on | settings, tags, tag rules, harness templates |
| `manage` | off | this device's upkeep: Claude directories, errors, branch status, model validation, retention preview, session tips |
| `ide` | off | the IDE bridge of this device's sessions: open files, open a file, diagnostics |

The first three are today's list, so nothing changes for a group until
the user changes a grant. `manage` and `ide` are routes no member reached
before.

- Grants are this device's own, set only here: kept under the
  `remote_grants` setting (`{ [memberId]: { [group]: boolean } }`, a
  missing group is its default), which a member can neither read nor
  change (`remote_` keys).
- `GET /api/remote/grants` → `{ grants: { [memberId]: Record<Group, boolean> } }`
  for every member of the group but this device;
  `PUT /api/remote/grants/:id` with `{ [group]: boolean }` (any subset)
  sets them, `404` for a device not in the group. `/api/remote…` is on no
  list, so no member reaches these.
- A member removed from the group takes its grants along.
- A call outside the member's grants is answered `403
  { error: 'not_granted', grant: <group> }`; one on no group stays `403
  { error: 'not_allowed' }`.
- The device only knows who asks, not whether a window or a session's
  MCP asked: a grant holds for both.

## 2. Settings → Devices

Under each other member of the group, the five grants as toggles, with
one line of what each covers. A toggle saves at once. A phone row shows
them too: a phone is a member like any other.

The toggles are folded by default (canvas `Feature - Device group 2`
50a): under the member's row one line, *Permissions on this Mac · all
allowed* (or *4 of 5 allowed*, *none allowed*), says how many are on and
opens or closes them. With several members the section stays short and
each member's state reads without opening anything. Saving and a failed
save's line under the member are the same open or folded; the grants hide
while the row asks to confirm Remove or Update in place.

## 3. The orbital MCP on another device

- `orbital_read` and `orbital_act` take an optional `machine`: the
  operation runs on that member. An operation on another member's
  session needs none: it runs on that session's device by itself.
- `spawn_session` takes `machine` too; its `cwd` is then required and is
  a path on that device. The parent's permission mode and model go along.
- A new `list_devices` operation names the group's other members, their
  kind and whether each is up.
- A refusal is put in words the session can act on: `not_granted` names
  the device and the grant to turn on there in Settings → Devices;
  `member_offline` says the device is offline.

## Scope

- For: anyone with more than one device in a group.
- Lives: on by default; inert without a group.
- An existing user notices: one folded *Permissions on this Mac* line
  under each other device in Settings → Devices, opening its five toggles. What members could do before stays on; upkeep and
  IDE are new and off.
- Can be set: each grant, per member, on the device it protects.

## Phone

A phone is a member like any other, so its grants show on the Mac and the
Mac enforces them; nothing changes in the phone app. The phone runs no
sessions of its own and has no grants to give, so it gets no toggles —
and folding them on the Mac leaves the phone's Devices screen as it is.
