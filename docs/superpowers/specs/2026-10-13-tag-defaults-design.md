---
id: 2026-10-13-tag-defaults-design
title: Tag defaults — each tag carries its launch config
status: done
type: spec
domain: sessions
related:
  - 2026-10-04-multiple-claude-directories-design
  - 2026-09-18-tag-clusters-design
  - pick-the-claude-directory-with-the-most-headroom
tags:
  - settings
  - tags
---
# Tag defaults

Each tag can carry a default launch config: Claude directory, model, permission mode, and effort. When a new session is launched with a tag, any of the four values the request does not name comes from the tag's config, else from the global default.

The same resolution rule applies to spawn_session children, so a piece of work spreads across accounts without picking the directory each time.

## Schema

Four nullable columns added to `tags` (migration 0028):

| column | type | meaning |
|---|---|---|
| `claude_dir_id` | integer | The Claude directory to launch under |
| `model` | text | The model to use |
| `permission_mode` | text | The permission mode ('ask'/'allow'/'deny') |
| `effort` | text | The harness step effort ('low'/'medium'/'high'/'ultra') |

Null = no tag default, fall back to global defaults. The phone decision appears below.

## API

`GET /api/tags` and the session shape carry all four in snake_case. The tags API validates them:

- `PATCH /api/tags/:id` accepts `claude_dir_id` (must exist or be null), `model`, `permission_mode` ('ask'/'allow'/'deny' or null), `effort` ('low'/'medium'/'high'/'ultra' or null).
- Null explicitly clears a default; absent means do not change it.
- Deleting a Claude directory nulls the tags that point at it.

## Resolution

When a new session is launched (POST /api/sessions), the server resolves each config value in order:

1. **Request-named value** — the request provides a value explicitly.
2. **Tag default** — the session's tag has a default for this value.
3. **Global default** — the general Settings value.

Absence from the request and a null tag default both fall through to global; they are the same.

### The Claude directory

The directory resolution has one rule: if the tag specifies a `claude_dir_id` and that directory's limits are exhausted (any limit window at 100% or an open limit wait — using cached limits, never waiting for a fresh probe), use the main default directory instead.

"Limits exhausted" is checked in `dirHasExhaustedLimits` (server/src/api/routes.ts) against `ctx.limits.snapshot()` — the cached reading.

### spawn_session

The Orbital MCP tool runs under the parent session's directory (spec 2026-10-04-multiple-claude-directories-design § 3). Tag defaults are resolved using the session's own tag, if it has one, the same as for any new session. Effort may be passed to the harness (not persisted).

## The phone

### On the Mac

The Settings UI for tags (web/src/panels/TagsRules.tsx or similar: the place tags are managed today) gains a row or section per tag where the user can set the four defaults. Null is the default for each; a UI picker is optional (a text field suffices).

The phone's New session screen preselects the tag's defaults in the pickers when the chosen tag has them, so the user sees what will launch without another choice. The preselection includes the effective `claude_dir_id` (with fallback for exhausted limits applied), so what is shown is what will launch.

### On the phone

The phone's New session screen preselects the tag's defaults; editing defaults stays on the Mac (the phone cannot browse or add directories and Settings is a Mac feature). The allowlist does not change.

**Phone decision:** Preselect tag defaults in the New session screen; editing stays on the Mac.

## Test coverage

- Server launch resolution: tag defaults vs request vs global for each of the four values.
- Tag defaults don't override explicit request values.
- Directory fallback when limits are exhausted (cached limits; never waits for a probe).
- Tags API validation: model/permission_mode/effort against allowed sets; `claude_dir_id` must exist.
- Persistence: new defaults are read back from the row.
- When a Claude directory is deleted, its tags' `claude_dir_id` columns are nulled.

## Shipping

Desktop **minor** (new session config capability), Android **minor** (preselection in New session). Changelog lines in desktop/CHANGELOG.md and mobile/CHANGELOG.md.

## Out of scope

- Persistence of effort to sessions (the value is resolved but not stored; harness integration is future work).
- A part 2 to "the most headroom" (pick-the-claude-directory-with-the-most-headroom): that idea doc notes part 1 (tag's directory) is done by this, part 2 (automatic choice) is backlog.
