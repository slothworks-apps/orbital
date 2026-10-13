---
id: 2026-10-13-tag-defaults-design
title: Tag defaults — each tag carries its launch config
status: done
type: spec
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - 2026-09-18-tag-clusters-design
  - 2026-09-30-a-session-spawns-sessions-design
  - 2026-10-03-usage-limits-design
  - pick-the-claude-directory-with-the-most-headroom
tags:
  - settings
  - tags
---
# Tag defaults

Each tag can carry a default launch config: the Claude directory, the
model and the permission mode. When a new session launches with a tag, any
of the three the request does not name comes from the tag, else from the
global default in Settings. A project gets its account, its model and its
mode by being tagged, without a choice at every launch.

This is as built.

## Schema

Three nullable columns on `tags` (migration 0028):

| column | type | meaning |
|---|---|---|
| `claude_dir_id` | integer | The Claude directory to launch under |
| `model` | text | The model id to launch with |
| `permission_mode` | text | `plan`, `acceptEdits`, `auto` or `bypassPermissions` |

Null means the tag has no default for that value; the global default
applies.

## API

- `GET /api/tags` carries the three fields, snake_case, after `anchor_y`.
- `PATCH /api/tags/:id` takes any of them. Absent leaves a value alone;
  null clears it back to the global default.
  - `claude_dir_id` must name a configured directory: else 400
    `unknown_claude_dir`.
  - `model` is held to the shape `POST /api/models/validate` accepts (a
    non-empty id without whitespace, at most 100 characters, trimmed): else
    400 `invalid_model`. The launch route itself checks no model, so there
    is no stricter rule to share; the catalog is not consulted, since a
    custom id set through Other is legitimate.
  - `permission_mode` must be one of the four modes Orbital offers: else
    400 `invalid_permission_mode`.
- Deleting a Claude directory (`DELETE /api/claude-dirs/:id`) nulls
  `claude_dir_id` on every tag that named it. Moving a directory to a new
  path keeps the reference: it is the same directory slot.
- `GET /api/sessions/defaults` gives each directory an `exhausted` flag,
  so both clients can preselect what the server would choose.

## Resolution

One pure function, `effectiveLaunchDefaults` in
`shared/src/launchDefaults.ts`, decides a tag's effective defaults from the
tag, the caller's global defaults and the directories (with whether each is
used up). The server, the Mac's dialog and the phone's screen all call it.
Per value, first match wins:

1. **The request's value.** A value the request names always wins.
2. **The tag's default.**
3. **The global default.**

### Which tag

The tag a session will wear: the one the request names (`tagId`), else the
tag the directory's rules give (matched with an empty title and the
request's mode, else the Settings mode), else the default tag. So defaults
set on the default tag apply to every launch no rule tags.

### The Claude directory

A tag's directory whose usage limit is used up gives way to the main
default directory (`default_claude_dir`). Used up means a window at 100 %
that has not reset yet, or a session of that directory waiting for a
reset (`claudeDirExhausted`, also in `shared/`). Only the cached limits are
read; a launch never waits for a probe. An untracked directory (an API key,
a plan without windows) is never used up. A tag directory that is missing
on disk is ignored, as if the tag named none.

### The launch route

`POST /api/sessions` fills what the request leaves out: the directory
from the tag, else `default_claude_dir`; the model from the tag, else
`default_model`; the mode from the tag, else `default_permission_mode`. A
resume ignores tag defaults: it runs under the session's own directory with
what it was sent.

Both clients always name every value they show, so on a client launch the
server's fill rarely applies; the clients preselect the same answer
instead, so what is shown is what launches.

### spawn_session

A child goes through the same resolution. The request is what the tool
names (the model); the tag is the parent's hand-picked tag, else the
child directory's rule, else the default tag; the global default is the
parent: its directory and model. So a tag's directory and model win over
the parent's, and the tool's model wins over both.

The mode is the exception: the child takes the parent's mode as it stands
now (spec 2026-09-30-a-session-spawns-sessions-design), named as the
request. A tag default never gives a child more autonomy than its parent.

## The Mac

**Settings → Tags.** The selected tag card, under the swatches, has three
pickers: DIRECTORY, MODEL, MODE, each with "Default" (null) first. The
option lists are the New session dialog's: the configured directories, the
model catalog of the tag's directory (a custom id the catalog does not list
stays shown as itself), and the four permission modes with their dots. The
directory picker shows only with two or more directories, as in the
dialog.

**New session.** The dialog overlays the tag's effective defaults on its
own prefill. The tag is the chosen chip, else the default tag; a chip
change, by hand or by a rule match, preselects again. A picker the user
changed by hand in this open keeps its value. The directory's hint says
where it came from: `from the tag · work`, or `from the default · work's
directory is at its limit`. The rule preview matches on the user's own mode,
not the tag's default: the tag decides that default, so matching on it
could swing between two tags. The mode remembered for the next open is the
user's own too. Opening the dialog reads the directories again, so the
used-up flags are fresh.

## The phone

The phone's New session screen preselects the same way: directory, model
and mode come from the tag over the screen's own prefill, unless picked by
hand. The phone has no tag picker, so the tag is the one the directory's
rules give (asked of the Mac with `POST /api/tag-rules/preview`, now on the
allowlist; it reads the rules and changes nothing), else the default tag.
A tag model the catalog does not list is passed over, as the phone has no
Other card; a `bypassPermissions` default is not preselected, the phone's
existing rule for the Mac's default mode.

**No MAC_FEATURES gate.** The phone asks for the rule match only when some
tag carries a default. A Mac from before this feature sends tags without
the three fields and directories without `exhausted`, so the phone asks
nothing and preselects nothing; there is no request an older Mac would
refuse.

**Editing stays on the Mac.** Tag defaults are settings, and Settings is a
Mac surface: the phone cannot write settings or browse directories, and
`PATCH /api/tags/:id` stays off the allowlist.

## Shipping

Desktop and phone, minor. One changelog line each.

## Out of scope

- An automatic choice of the directory with the most headroom: part 2 of
  `pick-the-claude-directory-with-the-most-headroom`.
- Effort: Orbital has no per-session effort setting at launch.
