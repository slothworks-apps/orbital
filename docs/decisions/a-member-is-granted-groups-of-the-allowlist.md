---
id: a-member-is-granted-groups-of-the-allowlist
title: A member is granted groups of the allowlist
type: adr
status: in-force
domain: remote
related:
  - every-member-reaches-one-literal-allowlist
  - 2026-10-19-member-grants-design
  - 2026-10-16-device-group-design
---

# Member grants: every member reaches a subset of the allowlist

Every member of the group reaches one literal allowlist: the set of routes that a member may call on this device. The allowlist — what is permitted — stays literal and small: every route a member may reach is named, and a new route on the server is not reachable from any member until someone adds it.

But what a member _is permitted_ to reach is not always what it _may_ reach. A member may lack the grant for some of the allowlisted routes. The grant groups on the allowlist partition the routes: every route belongs to exactly one group. The groups are:

- `sessions` (default on): read and drive sessions.
- `spawn` (default on): start sessions.
- `settings` (default on): settings, tags, tag rules, harness templates.
- `manage` (default off): this device's upkeep (Claude directories, errors, branch status, model validation, retention preview, session tips).
- `ide` (default off): the IDE bridge of this device's sessions.

The device grants each member the groups it trusts it to access. The user controls these grants in Settings → Devices, per member. A member removed from the group takes its grants along.

A call to a route whose group the member lacks is answered `403 { error: 'not_granted', grant: <group> }` — different from `not_allowed`, which is a route that is not on the list at all.

## Why

The allowlist keeps the phone's (and any other member's) reach intentional. It also keeps the principle literal: what is permitted is named, not derived.

But the allowlist is a bare minimum. A member of the group may not need to manage Claude directories or use the IDE — turning those on by default would only give members access they never asked for and may not be ready to use. Off-by-default grants let the user take on new features at their own pace: the `manage` routes and the IDE routes are on the allowlist now, but they are turned off for all members until the user sees them in Settings and decides.

This way, every member reaches one literal allowlist (principle); every member reaches a _subset_ of it (reality). When the allowlist grows, it is not an accident — it is a decision at the device level (the user turns the grant on) and the member level (the user grants it to the member).

## Consequences

- A call with a missing grant gets a clear error naming the grant: a session can ask the user to turn on `manage` or `ide` in Settings → Devices, by name, rather than getting a generic "not allowed" error.
- The phone's relay settings and other `remote_` keys stay this device's own: a member can neither read nor change them. `/api/remote/grants` and `/api/remote/grants/:id` are not on the allowlist, so no member reaches them.
- A malformed `remote_grants` setting (the setting that stores grants as `{ [memberId]: { [group]: boolean } }`) is parsed as an empty object (all members get defaults), never a crash.

## See also

- ADR [[every-member-reaches-one-literal-allowlist]] — the allowlist principle.
- Spec [[2026-10-19-member-grants-design]] — the full design.
- Domain [[device-group]] — device groups and the allowlist's place in them.
