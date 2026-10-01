---
id: the-phone-tunnels-the-api-behind-an-allowlist
title: The phone tunnels the existing API behind an allowlist
status: in-force
type: adr
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-mobile-remote-backend
tags:
  - remote
  - security
  - server
---
# The phone tunnels the existing API behind an allowlist

## Context

A phone needs to do everything the web app does to a session: list,
read, decide, spawn, tag, pin, interrupt, upload images. That surface
already exists as Fastify routes and hub topics for `web/`. The relay
carries only opaque encrypted frames, so whatever the Mac does with a
decrypted frame decides what a phone can reach.

Two other shapes were on the table: build a second, purpose-built mobile
protocol, or bridge through claude.ai's own Remote Control / SDK. Both
were already ruled out in the spec's brainstorming for the feature as a
whole; this ADR is about what a decrypted frame turns into inside the
Mac process, which the spec left as "the existing API and hub topics,
behind an allowlist" without saying how that allowlist is checked.

## Decision

A phone's `http` frame goes through Fastify's own `inject()` — in
process, same routes, same validation, same error shapes — but only for
a method+path pair on a literal list (`server/src/remote/allowlist.ts`).
`allowedPath` is the one function allowed to decide: it accepts a raw
path only if it is already byte-for-byte the canonical string the WHATWG
URL parser (what Node's HTTP stack and therefore Fastify's router use)
would produce, and only if every path segment matches a restricted
alphabet (`[A-Za-z0-9_-]+`). Canonical-but-unrestricted would let an
encoded segment like `%2e%2e` through structurally; restricted-but-
uncanonical would approve a string the real router rewrites before
matching it. Both checks are required, together, so the string handed to
`inject()` is provably the string Fastify will route — not a string that
merely looks safe. A phone's `subscribe` is checked the same way at the
hub, by an allowlist (`PHONE_ALLOWED_TOPICS` and its per-id prefixes, in
`server/src/remote/phoneSession.ts`): the topics the web client uses and
nothing else, so the `remote` topic — pairing and device state — and any
topic added later stay Mac-only until listed. (A denylist of `remote`
alone until 2026-10-01.)

## Alternatives ruled out

- **A purpose-built mobile protocol.** Leaner on the wire, but a second
  protocol next to the hub, and every new web feature needs projecting
  onto it by hand. Already ruled out in the spec's brainstorming.
- **The claude.ai Remote Control / SDK bridge.** Alpha API,
  trusted-device enrolment unsolved, and the phone would only ever see
  what the Claude app itself shows — no map, no tags, nothing Orbital
  knows that Claude's own UI does not. Already ruled out in the spec.
- **A pattern-based allowlist** (regex over path templates, or deriving
  it from the route table at boot). Rejected for the same reason a
  purpose-built protocol was: a new server route would be reachable from
  a phone by default, the opposite of the intended default-deny. A
  literal list makes every addition a conscious line.
- **Trusting the router to reject what it would reject anyway.** It
  does, eventually — but by then `inject()` has already been called with
  attacker-controlled input, and Fastify's router is not the thing this
  code is trying to keep provably correct. Checking canonicalisation
  before the call, not relying on the call's own safety, is what makes
  the allowlist a real boundary rather than a label on one.

## Consequences

- Every new server route is unreachable from a phone until someone adds
  it to `ALLOWED_ROUTES`. That is friction by design, not an oversight to
  fix later.
- `/api/files`, the IDE bridge, every other settings route and dev tools
  stay server-local even with the remote on, because they were never
  added.
- `allowedPath` is the one place path-handling bugs in this feature can
  live; a change to it needs the same scrutiny as a new entry on the
  list, not less.
