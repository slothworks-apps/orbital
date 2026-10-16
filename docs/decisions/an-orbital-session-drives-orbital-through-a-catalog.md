---
id: an-orbital-session-drives-orbital-through-a-catalog
title: A session drives Orbital through one catalog of its own routes
status: in-force
type: adr
domain: control
related:
  - 2026-10-13-orbital-controls-itself-design
  - orbital-features
tags:
  - server
  - mcp
---
# A session drives Orbital through one catalog of its own routes

## Context

A session should be able to do anything the user can do in Orbital. The
server already exposes every feature as a route under `/api`, and the phone
already calls those routes in-process through `app.inject`.

## Decision

Three tools on the `orbital` MCP server — `orbital_operations`,
`orbital_read`, `orbital_act` — over a catalog of named operations, each one
route. A call is the route itself, entered through `app.inject` with the API
token, so it does exactly what the user's click does, validation included.

## Ruled out

- **A tool per route.** About a hundred tools in every session's context, on
  every turn, whether or not it ever touches Orbital.
- **New back ends beside the routes**, as `list_sessions` has. Each feature
  would be built twice and the two would drift.
- **The raw API as one tool taking a method and a path.** No list of what is
  allowed: pairing a phone or writing the relay secret would be as reachable
  as renaming a session. The catalog is the list, as the phone's allowlist is
  the phone's.

## Consequences

Reads and acts are separate tools so reads can sit in `allowedTools` without
a card. A test fails when an operation points at a route the server no
longer registers.
